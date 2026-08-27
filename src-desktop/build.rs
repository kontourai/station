fn main() {
    println!("cargo:rustc-env=STATION_NODE_ENGINE={}", read_node_engine());
    tauri_build::build()
}

fn read_node_engine() -> String {
    let package =
        std::fs::read_to_string("../package.json").expect("read package.json for engines.node");
    let engines = package
        .split_once("\"engines\"")
        .expect("package.json engines")
        .1;
    let node = engines
        .split_once("\"node\"")
        .expect("package.json engines.node")
        .1;
    node.split_once(':')
        .and_then(|(_, value)| value.split('"').nth(1))
        .expect("package.json engines.node string")
        .to_string()
}
