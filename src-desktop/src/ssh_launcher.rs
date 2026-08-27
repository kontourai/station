use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::TcpListener;
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const REPOSITORY_URL: &str = "https://github.com/kontourai/station.git";
// Anonymous https fails on a private repository; hosts whose GitHub auth is
// an ssh deploy key (the entire dogfood fleet) can only clone this form.
// The launcher tries https first (works for public + https-credentialed
// hosts, no ssh-agent requirements) and falls back to the ssh remote.
const REPOSITORY_SSH_URL: &str = "git@github.com:kontourai/station.git";
const CHECKOUT: &str = ".station/ssh-launch/checkout";
const STDERR_TAIL_BYTES: usize = 4096;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshLaunchRequest {
    pub target: String,
    pub sha: String,
    pub local_port: u16,
    pub remote_port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshLaunchStatus {
    pub launch_id: String,
    pub phase: LaunchPhase,
    pub reused: bool,
    pub identity_verified: bool,
    pub expected_sha: String,
    pub local_url: Option<String>,
    pub pairing_offer: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProbeResult {
    pub node_version: String,
    pub node_requirement: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LaunchPhase {
    Probing,
    Cloning,
    Installing,
    Starting,
    Ready,
    Failed,
}

struct LaunchEntry {
    status: SshLaunchStatus,
    forward: Option<Child>,
}

#[derive(Default)]
pub struct SshLaunches(Arc<Mutex<HashMap<String, LaunchEntry>>>);

impl Drop for SshLaunches {
    fn drop(&mut self) {
        if Arc::strong_count(&self.0) != 1 {
            return;
        }
        if let Ok(mut launches) = self.0.lock() {
            for entry in launches.values_mut() {
                if let Some(child) = entry.forward.as_mut() {
                    let _ = child.kill();
                }
            }
        }
    }
}

trait Runner: Send + Sync {
    fn run(&self, program: &str, args: &[String]) -> std::io::Result<Output>;
    fn spawn(&self, program: &str, args: &[String]) -> std::io::Result<Child>;
}

struct SystemRunner;
impl Runner for SystemRunner {
    fn run(&self, program: &str, args: &[String]) -> std::io::Result<Output> {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .output()
    }
    fn spawn(&self, program: &str, args: &[String]) -> std::io::Result<Child> {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
    }
}

fn validate_target(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 255
        || value.starts_with('-')
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'@'))
    {
        return Err(
            "SSH target must be a host or user@host using only letters, digits, '.', '-', and '_'."
                .into(),
        );
    }
    Ok(())
}

fn validate_sha(value: &str) -> Result<(), String> {
    if value.len() != 40 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(
            "The connected Station did not report a full build sha; SSH launch stopped.".into(),
        );
    }
    Ok(())
}

fn node_requirement() -> &'static str {
    env!("STATION_NODE_ENGINE")
}

fn required_node_major(requirement: &str) -> Option<u64> {
    requirement
        .trim()
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn node_satisfies(version: &str, requirement: &str) -> bool {
    let actual = version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|v| v.parse::<u64>().ok());
    // "24.x" is an exact-major pin, not a floor: npm's engine-strict install
    // rejects node 26 against it, so a >= probe here green-lights a launch
    // that npm ci then kills (observed live on the first fleet dogfood).
    if let Some(major) = requirement
        .trim()
        .strip_suffix(".x")
        .and_then(|v| v.parse::<u64>().ok())
    {
        return actual.map(|a| a == major).unwrap_or(false);
    }
    actual
        .zip(required_node_major(requirement))
        .map(|(a, r)| a >= r)
        .unwrap_or(false)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartDecision {
    Reuse,
    InstallAndLaunch,
}

fn decide_start(remote_ready: bool) -> StartDecision {
    if remote_ready {
        StartDecision::Reuse
    } else {
        StartDecision::InstallAndLaunch
    }
}

/// Station is never a trust writer, on any path that can open a session.
///
/// Without these two options every `ssh` this launcher runs inherits the
/// operator's ambient policy, and under the widespread
/// `StrictHostKeyChecking=accept-new` (or `no`) OpenSSH silently accepts AND
/// RECORDS the key of a host nobody confirmed. The server's probe and master
/// session pin exactly this pair; the Tauri `ssh_env_probe` /
/// `ssh_launch_start` path reaches a remote shell just as directly, so it
/// fails closed on the same terms.
///
/// The known_hosts LOCATION is deliberately not overridden here, matching the
/// server's master argv: an operator's configured `UserKnownHostsFile` is
/// their trust store, and replacing it would reject hosts they legitimately
/// confirmed.
const HOST_KEY_POLICY: [&str; 4] = [
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
];

fn ssh_args(target: &str, remote: &[&str]) -> Vec<String> {
    let mut args = vec!["-o".into(), "BatchMode=yes".into()];
    args.extend(HOST_KEY_POLICY.iter().map(|value| (*value).to_string()));
    args.push("--".into());
    args.push(target.into());
    // OpenSSH transmits the remote command as one shell string. Quote each
    // already-validated argv value so the remote shell reconstructs it
    // exactly; caller values are never interpolated into script source.
    args.push(
        remote
            .iter()
            .map(|value| format!("'{}'", value.replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join(" "),
    );
    args
}

fn checkout_steps(target: &str, sha: &str) -> Vec<Vec<String>> {
    vec![
        ssh_args(target, &["sh", "-c", "if [ -d \"$1/.git\" ]; then GIT_TERMINAL_PROMPT=0 git -C \"$1\" fetch --prune origin || git -C \"$1\" fetch --prune \"$3\" \"+refs/heads/*:refs/remotes/origin/*\"; else mkdir -p \"${1%/*}\" && { GIT_TERMINAL_PROMPT=0 git clone \"$2\" \"$1\" || git clone \"$3\" \"$1\"; }; fi", "station-ssh-checkout", CHECKOUT, REPOSITORY_URL, REPOSITORY_SSH_URL]),
        ssh_args(target, &["git", "-C", CHECKOUT, "checkout", "--detach", sha]),
        ssh_args(target, &["git", "-C", CHECKOUT, "rev-parse", "HEAD"]),
    ]
}

fn forward_args(request: &SshLaunchRequest) -> Vec<String> {
    let mut args = vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
    ];
    args.extend(HOST_KEY_POLICY.iter().map(|value| (*value).to_string()));
    args.extend([
        "-L".into(),
        format!("{}:127.0.0.1:{}", request.local_port, request.remote_port),
        "-N".into(),
        "--".into(),
        request.target.clone(),
    ]);
    args
}

fn output_error(output: &Output) -> String {
    let bytes = if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    let start = bytes.len().saturating_sub(STDERR_TAIL_BYTES);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

fn checked_run(runner: &dyn Runner, args: Vec<String>) -> Result<Output, String> {
    let output = runner.run("ssh", &args).map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(output_error(&output))
    }
}

fn set_phase(state: &Arc<Mutex<HashMap<String, LaunchEntry>>>, id: &str, phase: LaunchPhase) {
    if let Some(entry) = state.lock().expect("ssh launch state poisoned").get_mut(id) {
        entry.status.phase = phase;
    }
}

fn fail(state: &Arc<Mutex<HashMap<String, LaunchEntry>>>, id: &str, error: String) {
    if let Some(entry) = state.lock().expect("ssh launch state poisoned").get_mut(id) {
        if let Some(child) = entry.forward.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        entry.forward = None;
        entry.status.phase = LaunchPhase::Failed;
        entry.status.error = Some(error);
    }
}

fn execute(
    state: Arc<Mutex<HashMap<String, LaunchEntry>>>,
    id: String,
    request: SshLaunchRequest,
    runner: Arc<dyn Runner>,
) -> Result<(), String> {
    checked_run(runner.as_ref(), ssh_args(&request.target, &["true"]))?;
    checked_run(
        runner.as_ref(),
        ssh_args(&request.target, &["git", "--version"]),
    )
    .map_err(|e| format!("Remote git is required: {e}"))?;
    let node = checked_run(
        runner.as_ref(),
        ssh_args(&request.target, &["node", "--version"]),
    )
    .map_err(|e| format!("Remote Node.js {} is required: {e}", node_requirement()))?;
    let node_version = String::from_utf8_lossy(&node.stdout);
    if !node_satisfies(&node_version, node_requirement()) {
        return Err(format!(
            "Remote Node.js {} is required; found {}.",
            node_requirement(),
            node_version.trim()
        ));
    }

    set_phase(&state, &id, LaunchPhase::Cloning);
    for (index, args) in checkout_steps(&request.target, &request.sha)
        .into_iter()
        .enumerate()
    {
        let output = checked_run(runner.as_ref(), args)?;
        if index == 2 && String::from_utf8_lossy(&output.stdout).trim() != request.sha {
            return Err(
                "Remote checkout HEAD did not match the pinned build sha; nothing was run.".into(),
            );
        }
    }

    let probe = runner
        .run(
            "ssh",
            &ssh_args(
                &request.target,
                &[
                    "curl",
                    "-fsS",
                    &format!(
                        "http://127.0.0.1:{}/.well-known/station/v1",
                        request.remote_port
                    ),
                ],
            ),
        )
        .map_err(|e| e.to_string())?;
    let reuse = if probe.status.success() {
        let body: serde_json::Value = serde_json::from_slice(&probe.stdout).map_err(|_| {
            format!(
                "Remote port {} is occupied by a service that is not Station.",
                request.remote_port
            )
        })?;
        if body
            .get("environmentId")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .is_none()
        {
            return Err(format!(
                "Remote port {} is occupied by a service that is not Station.",
                request.remote_port
            ));
        }
        true
    } else {
        false
    };
    if let Some(entry) = state
        .lock()
        .expect("ssh launch state poisoned")
        .get_mut(&id)
    {
        entry.status.reused = reuse;
    }
    if decide_start(reuse) == StartDecision::InstallAndLaunch {
        let ui_port = request
            .remote_port
            .checked_add(10)
            .ok_or("Remote port too high to derive a UI port.")?;
        set_phase(&state, &id, LaunchPhase::Installing);
        checked_run(
            runner.as_ref(),
            ssh_args(&request.target, &["npm", "--prefix", CHECKOUT, "ci"]),
        )?;
        set_phase(&state, &id, LaunchPhase::Starting);
        // Pin BOTH ports: the default UI port (3000) is reserved for the
        // user, and a stale sibling instance on it fails the boot identity
        // check (observed live: a two-day-old orphan from another session).
        checked_run(runner.as_ref(), ssh_args(&request.target, &["sh", "-c", "cd \"$1\" && STATION_HOST=127.0.0.1 ./station start --instance=ssh-launched --port=\"$2\" --ui-port=\"$3\"", "station-ssh-start", CHECKOUT, &request.remote_port.to_string(), &ui_port.to_string()]))?;
    } else {
        set_phase(&state, &id, LaunchPhase::Starting);
    }

    let forward = runner
        .spawn("ssh", &forward_args(&request))
        .map_err(|e| e.to_string())?;
    {
        let mut guard = state.lock().expect("ssh launch state poisoned");
        let entry = guard
            .get_mut(&id)
            .ok_or_else(|| "SSH launch was cancelled.".to_string())?;
        entry.forward = Some(forward);
    }
    let offer = checked_run(
        runner.as_ref(),
        ssh_args(
            &request.target,
            &[
                "sh",
                "-c",
                "cd \"$1\" && ./station environment offer --payload-only --advertise-url \"$2\"",
                "station-ssh-offer",
                CHECKOUT,
                &format!("http://127.0.0.1:{}", request.local_port),
            ],
        ),
    )?;
    let pairing_offer = String::from_utf8_lossy(&offer.stdout).trim().to_string();
    if pairing_offer.lines().count() != 1 || !pairing_offer.starts_with("station-pairing:v1:") {
        return Err("Remote Station did not return a payload-only pairing offer.".into());
    }
    let mut guard = state.lock().expect("ssh launch state poisoned");
    if let Some(entry) = guard.get_mut(&id) {
        entry.status.phase = LaunchPhase::Ready;
        entry.status.local_url = Some(format!("http://127.0.0.1:{}", request.local_port));
        entry.status.pairing_offer = Some(pairing_offer);
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_env_probe(target: String) -> Result<SshProbeResult, String> {
    validate_target(&target)?;
    let runner = SystemRunner;
    checked_run(&runner, ssh_args(&target, &["true"]))?;
    checked_run(&runner, ssh_args(&target, &["git", "--version"]))
        .map_err(|e| format!("Remote git is required: {e}"))?;
    let node = checked_run(&runner, ssh_args(&target, &["node", "--version"]))
        .map_err(|e| format!("Remote Node.js {} is required: {e}", node_requirement()))?;
    let node_version = String::from_utf8_lossy(&node.stdout).trim().to_string();
    if !node_satisfies(&node_version, node_requirement()) {
        return Err(format!(
            "Remote Node.js {} is required; found {}.",
            node_requirement(),
            node_version
        ));
    }
    Ok(SshProbeResult {
        node_version,
        node_requirement: node_requirement().to_string(),
    })
}

#[tauri::command]
pub fn ssh_launch_start(
    mut request: SshLaunchRequest,
    launches: State<'_, SshLaunches>,
) -> Result<String, String> {
    validate_target(&request.target)?;
    validate_sha(&request.sha)?;
    request.local_port = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Could not allocate a local SSH forward port: {e}"))?
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    if request.local_port == request.remote_port {
        return Err("Local and remote SSH-forward ports must differ.".into());
    }
    let id = format!(
        "ssh-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let status = SshLaunchStatus {
        launch_id: id.clone(),
        phase: LaunchPhase::Probing,
        reused: false,
        identity_verified: false,
        expected_sha: request.sha.clone(),
        local_url: None,
        pairing_offer: None,
        error: None,
    };
    let mut launch_guard = launches
        .0
        .lock()
        .map_err(|_| "SSH launch state is unavailable".to_string())?;
    if launch_guard.len() >= 64 {
        let terminal = launch_guard.iter().find_map(|(key, entry)| {
            matches!(entry.status.phase, LaunchPhase::Failed).then(|| key.clone())
        });
        if let Some(key) = terminal {
            launch_guard.remove(&key);
        }
    }
    launch_guard.insert(
        id.clone(),
        LaunchEntry {
            status,
            forward: None,
        },
    );
    drop(launch_guard);
    let state = launches.0.clone();
    let thread_id = id.clone();
    thread::spawn(move || {
        if let Err(error) = execute(
            state.clone(),
            thread_id.clone(),
            request,
            Arc::new(SystemRunner),
        ) {
            fail(&state, &thread_id, error);
        }
    });
    Ok(id)
}

#[tauri::command]
pub fn ssh_launch_cancel(
    launch_id: String,
    launches: State<'_, SshLaunches>,
) -> Result<(), String> {
    let mut guard = launches
        .0
        .lock()
        .map_err(|_| "SSH launch state is unavailable".to_string())?;
    if let Some(mut entry) = guard.remove(&launch_id) {
        if let Some(child) = entry.forward.as_mut() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_launch_mark_identity_verified(
    launch_id: String,
    launches: State<'_, SshLaunches>,
) -> Result<(), String> {
    let mut guard = launches
        .0
        .lock()
        .map_err(|_| "SSH launch state is unavailable".to_string())?;
    let entry = guard
        .get_mut(&launch_id)
        .ok_or_else(|| "SSH launch was not found.".to_string())?;
    entry.status.identity_verified = true;
    Ok(())
}

#[tauri::command]
pub fn ssh_launch_status(
    launch_id: String,
    launches: State<'_, SshLaunches>,
) -> Result<SshLaunchStatus, String> {
    let mut guard = launches
        .0
        .lock()
        .map_err(|_| "SSH launch state is unavailable".to_string())?;
    let entry = guard
        .get_mut(&launch_id)
        .ok_or_else(|| "SSH launch was not found.".to_string())?;
    if entry.status.phase == LaunchPhase::Ready
        && entry
            .forward
            .as_mut()
            .and_then(|child| child.try_wait().ok())
            .flatten()
            .is_some()
    {
        entry.status.phase = LaunchPhase::Failed;
        entry.status.error = Some("launcher closed".into());
    }
    Ok(entry.status.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::os::unix::process::ExitStatusExt;

    #[derive(Clone)]
    struct FakeRunner {
        calls: Arc<Mutex<Vec<(String, Vec<String>)>>>,
        outputs: Arc<Mutex<VecDeque<Output>>>,
        spawned_pids: Arc<Mutex<Vec<u32>>>,
    }

    impl FakeRunner {
        fn new(outputs: Vec<Output>) -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                outputs: Arc::new(Mutex::new(outputs.into())),
                spawned_pids: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Runner for FakeRunner {
        fn run(&self, program: &str, args: &[String]) -> std::io::Result<Output> {
            self.calls
                .lock()
                .unwrap()
                .push((program.into(), args.to_vec()));
            self.outputs
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| std::io::Error::other("unexpected fake runner call"))
        }

        fn spawn(&self, program: &str, args: &[String]) -> std::io::Result<Child> {
            self.calls
                .lock()
                .unwrap()
                .push((program.into(), args.to_vec()));
            let child = Command::new("sleep").arg("60").spawn()?;
            self.spawned_pids.lock().unwrap().push(child.id());
            Ok(child)
        }
    }

    fn output(success: bool, stdout: impl Into<Vec<u8>>) -> Output {
        Output {
            status: std::process::ExitStatus::from_raw(if success { 0 } else { 1 << 8 }),
            stdout: stdout.into(),
            stderr: Vec::new(),
        }
    }

    fn request() -> SshLaunchRequest {
        SshLaunchRequest {
            target: "host".into(),
            sha: "a".repeat(40),
            local_port: 45678,
            remote_port: 3141,
        }
    }

    fn launch_state(
        id: &str,
        request: &SshLaunchRequest,
    ) -> Arc<Mutex<HashMap<String, LaunchEntry>>> {
        Arc::new(Mutex::new(HashMap::from([(
            id.into(),
            LaunchEntry {
                status: SshLaunchStatus {
                    launch_id: id.into(),
                    phase: LaunchPhase::Probing,
                    reused: false,
                    identity_verified: false,
                    expected_sha: request.sha.clone(),
                    local_url: None,
                    pairing_offer: None,
                    error: None,
                },
                forward: None,
            },
        )])))
    }

    fn successful_prefix(request: &SshLaunchRequest, probe: Output) -> Vec<Output> {
        vec![
            output(true, ""),
            output(true, "git version 2.0"),
            output(true, "v24.1.0"),
            output(true, ""),
            output(true, ""),
            output(true, format!("{}\n", request.sha)),
            probe,
        ]
    }

    #[test]
    fn execute_aborts_on_head_mismatch_before_install() {
        let request = request();
        let runner = FakeRunner::new(vec![
            output(true, ""),
            output(true, "git version 2.0"),
            output(true, "v24.1.0"),
            output(true, ""),
            output(true, ""),
            output(true, format!("{}\n", "b".repeat(40))),
        ]);
        let error = execute(
            launch_state("head-mismatch", &request),
            "head-mismatch".into(),
            request,
            Arc::new(runner.clone()),
        )
        .unwrap_err();
        assert!(error.contains("HEAD did not match"));
        assert!(!runner
            .calls()
            .iter()
            .any(|(_, args)| args.join(" ").contains("'npm'")));
    }

    #[test]
    fn execute_rejects_non_station_probe_instead_of_reusing_occupied_port() {
        let request = request();
        let runner = FakeRunner::new(successful_prefix(
            &request,
            output(true, br#"{"service":"other"}"#.to_vec()),
        ));
        let error = execute(
            launch_state("occupied", &request),
            "occupied".into(),
            request,
            Arc::new(runner.clone()),
        )
        .unwrap_err();
        assert!(error.contains("port 3141 is occupied"));
        assert!(!runner
            .calls()
            .iter()
            .any(|(_, args)| args.iter().any(|arg| arg == "-L")));
    }

    #[test]
    fn execute_uses_forward_and_payload_only_argv_contracts() {
        let request = request();
        let mut outputs = successful_prefix(&request, output(false, "not listening"));
        outputs.extend([
            output(true, ""),
            output(true, ""),
            output(true, "station-pairing:v1:payload\n"),
        ]);
        let runner = FakeRunner::new(outputs);
        execute(
            launch_state("argv", &request),
            "argv".into(),
            request,
            Arc::new(runner.clone()),
        )
        .unwrap();
        let calls = runner.calls();
        let forward = calls
            .iter()
            .find(|(_, args)| args.iter().any(|arg| arg == "-L"))
            .unwrap();
        assert!(forward
            .1
            .windows(2)
            .any(|pair| pair == ["-o", "ExitOnForwardFailure=yes"]));
        let offer = calls
            .iter()
            .find(|(_, args)| args.join(" ").contains("environment offer"))
            .unwrap();
        assert!(offer
            .1
            .join(" ")
            .contains("environment offer --payload-only --advertise-url"));
    }

    #[test]
    fn offer_failure_kills_the_spawned_forward() {
        let request = request();
        let mut outputs = successful_prefix(&request, output(false, "not listening"));
        outputs.extend([
            output(true, ""),
            output(true, ""),
            output(false, "offer failed"),
        ]);
        let runner = FakeRunner::new(outputs);
        let state = launch_state("offer-failure", &request);
        let result = execute(
            state.clone(),
            "offer-failure".into(),
            request,
            Arc::new(runner.clone()),
        );
        fail(&state, "offer-failure", result.unwrap_err());
        let pid = runner.spawned_pids.lock().unwrap()[0];
        let status = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .unwrap();
        assert!(!status.success(), "forward child {pid} remained alive");
    }

    #[test]
    fn execute_rejects_multiline_offer_output_and_cleans_up_forward() {
        let request = request();
        let mut outputs = successful_prefix(&request, output(false, "not listening"));
        outputs.extend([
            output(true, ""),
            output(true, ""),
            output(true, "Pair this device:\nstation-pairing:v1:payload\n"),
        ]);
        let runner = FakeRunner::new(outputs);
        let state = launch_state("prose", &request);
        let error = execute(state.clone(), "prose".into(), request, Arc::new(runner)).unwrap_err();
        assert!(error.contains("payload-only"));
        fail(&state, "prose", error);
        assert!(state.lock().unwrap()["prose"]
            .status
            .pairing_offer
            .is_none());
    }
    #[test]
    fn target_validation_blocks_argv_injection() {
        for value in [
            "-oProxyCommand=oops",
            "host;touch /tmp/x",
            "host name",
            "host\ncommand",
        ] {
            assert!(validate_target(value).is_err(), "accepted {value:?}");
        }
        assert!(validate_target("dev@brian-media.tailnet").is_ok());
    }
    #[test]
    fn checkout_sequence_is_byte_exact_and_verifies_head_last() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            checkout_steps("devbox", sha),
            vec![
                vec!["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "--", "devbox", "'sh' '-c' 'if [ -d \"$1/.git\" ]; then GIT_TERMINAL_PROMPT=0 git -C \"$1\" fetch --prune origin || git -C \"$1\" fetch --prune \"$3\" \"+refs/heads/*:refs/remotes/origin/*\"; else mkdir -p \"${1%/*}\" && { GIT_TERMINAL_PROMPT=0 git clone \"$2\" \"$1\" || git clone \"$3\" \"$1\"; }; fi' 'station-ssh-checkout' '.station/ssh-launch/checkout' 'https://github.com/kontourai/station.git' 'git@github.com:kontourai/station.git'"],
                vec!["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "--", "devbox", "'git' '-C' '.station/ssh-launch/checkout' 'checkout' '--detach' '0123456789abcdef0123456789abcdef01234567'"],
                vec!["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "--", "devbox", "'git' '-C' '.station/ssh-launch/checkout' 'rev-parse' 'HEAD'"],
            ]
            .into_iter()
            .map(|v| v.into_iter().map(String::from).collect())
            .collect::<Vec<Vec<String>>>()
        );
    }
    #[test]
    fn node_engine_comparison_uses_build_requirement() {
        assert!(node_satisfies("v24.4.1", "24.x"));
        // An exact-major pin rejects newer majors too — the old >= assertion
        // here pinned the defect that green-lit node 26 against "24.x".
        assert!(!node_satisfies("25.0.0", "24.x"));
        assert!(!node_satisfies("v26.2.0", "24.x"));
        assert!(node_satisfies("v25.1.0", ">=24"));
        assert!(!node_satisfies("v23.9.0", "24.x"));
        assert!(!node_satisfies("garbage", "24.x"));
        // The predicate only supports exact-major ("N.x") and floor (">=N")
        // shapes; anything else (e.g. "^24", "24.1.x") would be silently
        // mis-approximated. Pin the build-time requirement to a supported
        // shape so an engines change to an unsupported form fails HERE.
        let requirement = node_requirement();
        let supported = requirement
            .strip_suffix(".x")
            .is_some_and(|v| v.parse::<u64>().is_ok())
            || requirement
                .strip_prefix(">=")
                .is_some_and(|v| v.trim().parse::<u64>().is_ok());
        assert!(supported, "unsupported engines.node shape: {requirement}");
    }
    #[test]
    fn status_phase_machine_and_reuse_decision_are_deterministic() {
        assert_eq!(decide_start(true), StartDecision::Reuse);
        assert_eq!(decide_start(false), StartDecision::InstallAndLaunch);
        let mut phase = LaunchPhase::Probing;
        for next in [
            LaunchPhase::Cloning,
            LaunchPhase::Installing,
            LaunchPhase::Starting,
            LaunchPhase::Ready,
        ] {
            phase = next;
        }
        assert_eq!(phase, LaunchPhase::Ready);
        phase = LaunchPhase::Failed;
        assert_eq!(phase, LaunchPhase::Failed);
    }
    #[test]
    fn mismatch_warning_derivation_is_explicit() {
        #[derive(PartialEq, Debug)]
        enum Provenance {
            Match,
            Mismatch,
            Unknown,
        }
        fn warning(expected: &str, actual: Option<&str>) -> Provenance {
            match actual {
                None => Provenance::Unknown,
                Some(value) if value == expected => Provenance::Match,
                Some(_) => Provenance::Mismatch,
            }
        }
        assert_eq!(warning("aaa", Some("bbb")), Provenance::Mismatch);
        assert_eq!(warning("aaa", Some("aaa")), Provenance::Match);
        assert_eq!(warning("aaa", None), Provenance::Unknown);
    }

    /// sol delta finding 2. Every argv this launcher builds has to carry the
    /// host-key policy, not just the ones a test happened to name — so this
    /// asserts over BOTH builders and over every step of a checkout plan,
    /// which is where a new `ssh_args` caller would otherwise slip through.
    #[test]
    fn every_launcher_argv_pins_the_host_key_policy() {
        fn pins(args: &[String]) -> bool {
            args.windows(2)
                .any(|pair| pair == ["-o", "StrictHostKeyChecking=yes"])
                && args
                    .windows(2)
                    .any(|pair| pair == ["-o", "UpdateHostKeys=no"])
        }

        let request = SshLaunchRequest {
            target: "host".into(),
            sha: "a".repeat(40),
            local_port: 45678,
            remote_port: 3141,
        };
        assert!(pins(&ssh_args("host", &["true"])));
        assert!(pins(&forward_args(&request)));
        for step in checkout_steps("host", &request.sha) {
            assert!(pins(&step), "checkout step missing host-key policy");
        }
    }

    /// The options must sit BEFORE the `--` terminator, or `ssh` reads them as
    /// part of the remote command instead of as its own configuration.
    #[test]
    fn host_key_policy_precedes_the_argument_terminator() {
        let args = ssh_args("host", &["true"]);
        let terminator = args.iter().position(|value| value == "--").unwrap();
        let policy = args
            .iter()
            .position(|value| value == "StrictHostKeyChecking=yes")
            .unwrap();
        assert!(policy < terminator);
        assert_eq!(args[terminator + 1], "host");
    }

    /// The trust store itself stays the operator's: overriding it here would
    /// reject hosts they legitimately confirmed in a configured file.
    #[test]
    fn launcher_never_overrides_the_operator_trust_store() {
        let request = SshLaunchRequest {
            target: "host".into(),
            sha: "a".repeat(40),
            local_port: 45678,
            remote_port: 3141,
        };
        for args in [ssh_args("host", &["true"]), forward_args(&request)] {
            assert!(!args
                .iter()
                .any(|value| value.starts_with("UserKnownHostsFile")));
        }
    }

    #[test]
    fn forward_requires_exit_on_failure_and_uses_allocated_port() {
        let request = SshLaunchRequest {
            target: "host".into(),
            sha: "a".repeat(40),
            local_port: 45678,
            remote_port: 3141,
        };
        let args = forward_args(&request);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ExitOnForwardFailure=yes"]));
        assert!(args.contains(&"45678:127.0.0.1:3141".to_string()));
    }
}
