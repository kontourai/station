//! A finite native request may finish during UIKit's discretionary background grace.
//! Expiration ends the assertion; it never retries a possibly dispatched write.

#[cfg(any(target_os = "ios", test))]
#[derive(Default)]
struct TaskState {
    finished: bool,
    identifier: Option<usize>,
}

#[cfg(any(target_os = "ios", test))]
impl TaskState {
    fn install(&mut self, identifier: usize, mut end: impl FnMut(usize)) {
        if self.finished {
            end(identifier);
        } else {
            self.identifier = Some(identifier);
        }
    }

    fn finish(&mut self, mut end: impl FnMut(usize)) {
        self.finished = true;
        if let Some(identifier) = self.identifier.take() {
            end(identifier);
        }
    }
}

#[cfg(target_os = "ios")]
mod platform {
    use super::TaskState;
    use block2::RcBlock;
    use dispatch2::DispatchQueue;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, MainThreadMarker};
    use std::sync::{Arc, Mutex};

    #[link(name = "UIKit", kind = "framework")]
    extern "C" {
        static UIBackgroundTaskInvalid: usize;
    }

    fn application() -> &'static AnyObject {
        MainThreadMarker::new().expect("background assertions are managed on the main queue");
        unsafe {
            msg_send![
                AnyClass::get(c"UIApplication").expect("UIKit UIApplication"),
                sharedApplication
            ]
        }
    }

    fn end(identifier: usize) {
        unsafe {
            let _: () = msg_send![application(), endBackgroundTask: identifier];
        }
    }

    fn finish(state: &Mutex<TaskState>) {
        state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .finish(end);
    }

    pub(crate) struct BackgroundTask(Arc<Mutex<TaskState>>);

    impl BackgroundTask {
        pub(crate) fn begin() -> Self {
            let state = Arc::new(Mutex::new(TaskState::default()));
            let pending = Arc::clone(&state);
            // Never wait for the main queue from a broker holding an admission lock.
            DispatchQueue::main().exec_async(move || {
                if pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .finished
                {
                    return;
                }
                let expiring = Arc::clone(&pending);
                let expiration = RcBlock::new(move || finish(&expiring));
                let identifier: usize = unsafe {
                    msg_send![application(), beginBackgroundTaskWithExpirationHandler: &*expiration]
                };
                if identifier != unsafe { UIBackgroundTaskInvalid } {
                    pending
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .install(identifier, end);
                } else {
                    log::warn!("iOS declined native request background grace");
                }
            });
            Self(state)
        }
    }

    impl Drop for BackgroundTask {
        fn drop(&mut self) {
            let state = Arc::clone(&self.0);
            DispatchQueue::main().exec_async(move || finish(&state));
        }
    }
}

#[cfg(target_os = "ios")]
pub(crate) use platform::BackgroundTask;

#[cfg(test)]
mod tests {
    use super::TaskState;

    #[test]
    fn completion_and_expiration_end_each_assertion_once_in_either_order() {
        for expire_first in [false, true] {
            let mut state = TaskState::default();
            let mut ended = Vec::new();
            if expire_first {
                state.finish(|id| ended.push(id));
            }
            state.install(42, |id| ended.push(id));
            state.finish(|id| ended.push(id));
            state.finish(|id| ended.push(id));
            assert_eq!(ended, [42]);
            assert!(state.identifier.is_none());
        }
    }
}
