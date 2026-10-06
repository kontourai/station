//! Capture cold launch options at the application's public delegate boundary.
//! Tao 0.35.3 emits warm Opened events but drops first-scene URLContexts.

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};
use objc2_foundation::NSString;
use std::ffi::CStr;
use std::sync::OnceLock;
use tauri::AppHandle;

struct LaunchHook {
    app: AppHandle,
    scene: Option<Imp>,
    launch: Imp,
    open: Imp,
}
static HOOK: OnceLock<LaunchHook> = OnceLock::new();
static SCENE_OPEN: OnceLock<Imp> = OnceLock::new();

#[link(name = "UIKit", kind = "framework")]
extern "C" {
    static UIApplicationLaunchOptionsURLKey: *mut AnyObject;
}

type SceneImp = unsafe extern "C-unwind" fn(
    *mut AnyObject,
    Sel,
    *mut AnyObject,
    *mut AnyObject,
    *mut AnyObject,
) -> *mut AnyObject;
type LaunchImp =
    unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject) -> Bool;
type OpenImp = unsafe extern "C-unwind" fn(
    *mut AnyObject,
    Sel,
    *mut AnyObject,
    *mut AnyObject,
    *mut AnyObject,
) -> Bool;
type SceneOpenImp =
    unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject);

pub(crate) fn install(app: AppHandle) -> Result<(), &'static str> {
    if objc2::MainThreadMarker::new().is_none() {
        return Err("main-thread");
    }
    // Tao 0.35.3 declares its owned AppDelegate on UIResponder. UIKit's
    // superclass is never wrapped; these are the app class's own methods.
    let class = AnyClass::get(c"AppDelegate").ok_or("app-class")?;
    if class.name() != c"AppDelegate"
        || class
            .superclass()
            .is_none_or(|base| base.name() != c"UIResponder")
    {
        return Err("app-superclass");
    }
    let uses_scenes = unsafe { multiple_scenes_enabled()? };
    let scene =
        class.instance_method(sel!(application:configurationForConnectingSceneSession:options:));
    if uses_scenes != scene.is_some() {
        return Err("scene-mode-selector");
    }
    let launch = class
        .instance_method(sel!(application:didFinishLaunchingWithOptions:))
        .ok_or("launch-selector")?;
    let open = class
        .instance_method(sel!(application:openURL:options:))
        .ok_or("open-selector")?;
    if launch.arguments_count() != 4 || open.arguments_count() != 5 {
        return Err("app-abi-count");
    }
    if !matches!(launch.return_type().to_bytes(), b"B" | b"c")
        || (2..4).any(|index| {
            launch
                .argument_type(index)
                .is_none_or(|value| value.to_bytes() != b"@")
        })
        || !matches!(open.return_type().to_bytes(), b"B" | b"c")
        || (2..5).any(|index| {
            open.argument_type(index)
                .is_none_or(|value| value.to_bytes() != b"@")
        })
    {
        return Err("app-abi-encoding");
    }
    if scene.is_some_and(|method| {
        method.arguments_count() != 5
            || method.return_type().to_bytes() != b"@"
            || (2..5).any(|index| {
                method
                    .argument_type(index)
                    .is_none_or(|value| value.to_bytes() != b"@")
            })
    }) {
        return Err("scene-configuration-abi");
    }
    HOOK.set(LaunchHook {
        app,
        scene: scene.map(|method| method.implementation()),
        launch: launch.implementation(),
        open: open.implementation(),
    })
    .map_err(|_| "duplicate-install")?;
    unsafe {
        if let Some(scene) = scene {
            scene.set_implementation(std::mem::transmute::<SceneImp, Imp>(scene_options));
        }
        launch.set_implementation(std::mem::transmute::<LaunchImp, Imp>(launch_options));
        open.set_implementation(std::mem::transmute::<OpenImp, Imp>(open_url));
    }
    Ok(())
}

unsafe fn multiple_scenes_enabled() -> Result<bool, &'static str> {
    // Match Tao's actual configuration switch, not an inferred OS version.
    let bundle_class = AnyClass::get(c"NSBundle").ok_or("bundle-class")?;
    let bundle: *mut AnyObject = msg_send![bundle_class, mainBundle];
    let info: *mut AnyObject = msg_send![bundle, infoDictionary];
    let manifest_key = NSString::from_str("UIApplicationSceneManifest");
    let manifest: *mut AnyObject = msg_send![info, objectForKey: &*manifest_key];
    if manifest.is_null() {
        return Ok(false);
    }
    let dictionary = AnyClass::get(c"NSDictionary").ok_or("manifest-class")?;
    let is_dictionary: Bool = msg_send![manifest, isKindOfClass: dictionary];
    if !is_dictionary.as_bool() {
        return Err("manifest-shape");
    }
    let enabled_key = NSString::from_str("UIApplicationSupportsMultipleScenes");
    let enabled: *mut AnyObject = msg_send![manifest, objectForKey: &*enabled_key];
    if enabled.is_null() {
        return Ok(false);
    }
    let number = AnyClass::get(c"NSNumber").ok_or("scene-flag-class")?;
    let is_number: Bool = msg_send![enabled, isKindOfClass: number];
    if !is_number.as_bool() {
        return Err("scene-flag-shape");
    }
    let enabled: Bool = msg_send![enabled, boolValue];
    Ok(enabled.as_bool())
}

unsafe fn is_relay_url(value: *mut AnyObject) -> bool {
    if value.is_null() {
        return false;
    }
    let scheme: *mut AnyObject = msg_send![value, scheme];
    if scheme.is_null() {
        return false;
    }
    let bytes: *const std::ffi::c_char = msg_send![scheme, UTF8String];
    if bytes.is_null() {
        return false;
    }
    CStr::from_ptr(bytes)
        .to_str()
        .ok()
        .and_then(|value| value.get(..14))
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("station-relay-"))
}

unsafe fn receive_relay_object(app: &AppHandle, value: *mut AnyObject) {
    match url_from_object(value) {
        Some(url) => crate::native_relay_link_intake::receive_opened(app, &[url]),
        None => crate::native_relay_link_intake::reject_invalid_delivery(app),
    }
}

unsafe fn install_scene_open(configuration: *mut AnyObject) -> Result<(), &'static str> {
    if configuration.is_null() {
        return Err("scene-configuration");
    }
    let class: *const AnyClass = msg_send![configuration, delegateClass];
    let class = class.as_ref().ok_or("scene-class")?;
    if class.name() != c"TaoSceneDelegate"
        || class
            .superclass()
            .is_none_or(|base| base.name() != c"NSObject")
    {
        return Err("scene-owned-class");
    }
    let method = class
        .instance_method(sel!(scene:openURLContexts:))
        .ok_or("scene-open-selector")?;
    if method.arguments_count() != 4
        || method.return_type().to_bytes() != b"v"
        || (2..4).any(|index| {
            method
                .argument_type(index)
                .is_none_or(|value| value.to_bytes() != b"@")
        })
    {
        return Err("scene-open-abi");
    }
    if SCENE_OPEN.get().is_none() {
        SCENE_OPEN
            .set(method.implementation())
            .map_err(|_| "duplicate-scene-install")?;
        method.set_implementation(std::mem::transmute::<SceneOpenImp, Imp>(scene_open));
    }
    Ok(())
}

unsafe extern "C-unwind" fn open_url(
    this: *mut AnyObject,
    selector: Sel,
    application: *mut AnyObject,
    value: *mut AnyObject,
    options: *mut AnyObject,
) -> Bool {
    let hook = HOOK
        .get()
        .expect("Station launch hook was installed before UIApplicationMain");
    if is_relay_url(value) {
        receive_relay_object(&hook.app, value);
        Bool::YES
    } else {
        let original: OpenImp = std::mem::transmute(hook.open);
        original(this, selector, application, value, options)
    }
}

unsafe extern "C-unwind" fn scene_open(
    this: *mut AnyObject,
    selector: Sel,
    scene: *mut AnyObject,
    contexts: *mut AnyObject,
) {
    let hook = HOOK
        .get()
        .expect("Station launch hook was installed before UIApplicationMain");
    let original: SceneOpenImp = std::mem::transmute(
        *SCENE_OPEN
            .get()
            .expect("Station scene hook was installed before scene delivery"),
    );
    let enumerator: *mut AnyObject = msg_send![contexts, objectEnumerator];
    let mut relays = Vec::new();
    let mut remaining = Vec::new();
    loop {
        let context: *mut AnyObject = msg_send![enumerator, nextObject];
        if context.is_null() {
            break;
        }
        let value: *mut AnyObject = msg_send![context, URL];
        if is_relay_url(value) {
            relays.push(value);
        } else {
            remaining.push(context);
        }
    }
    if relays.is_empty() {
        original(this, selector, scene, contexts);
        return;
    }
    for value in relays {
        receive_relay_object(&hook.app, value);
    }
    if !remaining.is_empty() {
        // NSSet has no order contract. Preserve every non-relay context
        // object; only the relay carriers are excluded from Tao's parser.
        let class = AnyClass::get(c"NSMutableSet").expect("Foundation mutable sets are available");
        let set: *mut AnyObject = msg_send![class, new];
        let set = Retained::<AnyObject>::from_raw(set)
            .expect("Foundation created the forwarding context set");
        for context in remaining {
            let _: () = msg_send![&*set, addObject: context];
        }
        original(this, selector, scene, Retained::as_ptr(&set).cast_mut());
    }
}

unsafe fn url_from_object(value: *mut AnyObject) -> Option<url::Url> {
    if value.is_null() {
        return None;
    }
    let string: *mut AnyObject = msg_send![value, absoluteString];
    if string.is_null() {
        return None;
    }
    let bytes: *const std::ffi::c_char = msg_send![string, UTF8String];
    if bytes.is_null() {
        return None;
    }
    CStr::from_ptr(bytes)
        .to_str()
        .ok()
        .and_then(|value| url::Url::parse(value).ok())
}

unsafe extern "C-unwind" fn scene_options(
    this: *mut AnyObject,
    selector: Sel,
    application: *mut AnyObject,
    session: *mut AnyObject,
    options: *mut AnyObject,
) -> *mut AnyObject {
    let hook = HOOK
        .get()
        .expect("Station launch hook was installed before UIApplicationMain");
    let original: SceneImp = std::mem::transmute(
        hook.scene
            .expect("Only the declared scene callback is wrapped"),
    );
    let configuration = original(this, selector, application, session, options);
    if let Err(stage) = install_scene_open(configuration) {
        use tauri::Manager;
        hook.app
            .state::<crate::native_relay_link_intake::NativeRelayLinkState>()
            .unavailable();
        log::error!("Station native relay scene delivery is unavailable ({stage}).");
    }
    if !options.is_null() {
        let contexts: *mut AnyObject = msg_send![options, URLContexts];
        if !contexts.is_null() {
            let enumerator: *mut AnyObject = msg_send![contexts, objectEnumerator];
            let mut urls = Vec::new();
            loop {
                let context: *mut AnyObject = msg_send![enumerator, nextObject];
                if context.is_null() {
                    break;
                }
                let value: *mut AnyObject = msg_send![context, URL];
                if let Some(url) = url_from_object(value) {
                    urls.push(url);
                }
            }
            crate::native_relay_link_intake::receive_opened(&hook.app, &urls);
        }
    }
    configuration
}

unsafe extern "C-unwind" fn launch_options(
    this: *mut AnyObject,
    selector: Sel,
    application: *mut AnyObject,
    options: *mut AnyObject,
) -> Bool {
    let hook = HOOK
        .get()
        .expect("Station launch hook was installed before UIApplicationMain");
    let original: LaunchImp = std::mem::transmute(hook.launch);
    let result = original(this, selector, application, options);
    if !options.is_null() {
        let value: *mut AnyObject =
            msg_send![options, objectForKey: UIApplicationLaunchOptionsURLKey];
        if let Some(url) = url_from_object(value) {
            crate::native_relay_link_intake::receive_opened(&hook.app, &[url]);
        }
    }
    result
}
