# The Tauri runtime instantiates the plugin reflectively by class name.
-keep class io.kontourai.station.agentactivity.AgentActivityPlugin { *; }

# The generated inset bridge calls this JNI class across the app/library boundary.
-keep class io.kontourai.station.agentactivity.NativeHttpNetwork { *; }
