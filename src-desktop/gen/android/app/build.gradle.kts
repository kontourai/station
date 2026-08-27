import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "io.kontourai.station"
    // Release signing. Tauri's own CLI has no knowledge of Android keystores —
    // `tauri android build` takes no signing flags and reads no
    // TAURI_ANDROID_KEYSTORE_* environment variable (verified against
    // crates/tauri-cli/ENVIRONMENT_VARIABLES.md and the `android build`
    // Options struct upstream, tauri-cli-v2.11.4). Release signing is
    // entirely this Gradle project's own responsibility. `.github/workflows/
    // release.yml`'s `android` job decodes ANDROID_KEYSTORE_BASE64 to a file
    // and exports these four TAURI_ANDROID_* variables specifically so this
    // block can consume them — the names mirror the repo's TAURI_SIGNING_*
    // desktop-updater convention but are Station's own wiring, not a
    // Tauri-provided contract. Without this block the release build type has
    // no signingConfig at all and produces an unsigned APK/AAB — Play/`apksigner
    // verify`/`jarsigner -verify -strict` all reject that at upload/verify
    // time, so absence fails loudly rather than shipping unsigned, but it
    // fails on every release until fixed. Guarded on TAURI_ANDROID_KEYSTORE_PATH
    // so the debug-only build-android.yml CI lane (which never sets these) is
    // unaffected: the release buildType simply has no signingConfig assigned
    // there, which is fine because nothing builds `assembleRelease`/
    // `bundleRelease` in that lane.
    val releaseKeystorePath = System.getenv("TAURI_ANDROID_KEYSTORE_PATH")
    signingConfigs {
        if (releaseKeystorePath != null) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = System.getenv("TAURI_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TAURI_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("TAURI_ANDROID_KEY_PASSWORD")
            }
        }
    }
    defaultConfig {
        // Station hosts are commonly plain-HTTP on LAN/tailnet IPs; a release
        // build that blocks cleartext cannot connect to any of them. Recorded
        // decision (PR #826 review): Android's network-security-config scopes
        // cleartext by DOMAIN only and cannot express IP ranges, and Station
        // hosts are entered as raw IPs — so the iOS-style narrow scope
        // (NSAllowsLocalNetworking) has no Android equivalent here. Blanket
        // cleartext is the accepted gap until hosts are addressed by name.
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "io.kontourai.station"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            if (releaseKeystorePath != null) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")