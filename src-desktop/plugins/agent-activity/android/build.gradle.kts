plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// Firebase client identity for push receipt. These values are not secrets —
// they ship inside every APK — but they bind the app to one Firebase project,
// so they come from the build environment rather than the repository. When
// they are absent Firebase does not initialize, `pushToken` reports
// `unconfigured`, and local rendering (`preview`) still works. This replaces
// the google-services Gradle plugin, which would need a google-services.json
// inside the regenerated gen/android project.
val firebaseValues = mapOf(
    "google_app_id" to System.getenv("STATION_FIREBASE_APP_ID"),
    "google_api_key" to System.getenv("STATION_FIREBASE_API_KEY"),
    "project_id" to System.getenv("STATION_FIREBASE_PROJECT_ID"),
    "gcm_defaultSenderId" to System.getenv("STATION_FIREBASE_SENDER_ID"),
)
val firebaseConfigured = firebaseValues.values.all { !it.isNullOrBlank() }
if (!firebaseConfigured && firebaseValues.values.any { !it.isNullOrBlank() }) {
    throw GradleException(
        "STATION_FIREBASE_* is partially set; set all of APP_ID, API_KEY, PROJECT_ID and SENDER_ID or none.",
    )
}
// Firebase validates these formats only at runtime, where a typo surfaces as
// a failed token fetch on the user's device. Fail the build instead.
if (firebaseConfigured) {
    val formats = mapOf(
        "google_app_id" to Regex("""1:\d+:android:[0-9a-f]+"""),
        "google_api_key" to Regex("""A[\w-]{38}"""),
        "project_id" to Regex("""[a-z][a-z0-9-]{4,28}[a-z0-9]"""),
        "gcm_defaultSenderId" to Regex("""\d+"""),
    )
    formats.forEach { (name, format) ->
        if (!format.matches(firebaseValues.getValue(name)!!)) {
            throw GradleException("STATION_FIREBASE value for $name does not match the Firebase format $format.")
        }
    }
}

android {
    namespace = "io.kontourai.station.agentactivity"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        if (firebaseConfigured) {
            firebaseValues.forEach { (name, value) -> resValue("string", name, value!!) }
        }
    }

    buildFeatures {
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    // 1.17 carries setRequestPromotedOngoing / setShortCriticalText (API 36).
    implementation("androidx.core:core:1.17.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("com.google.firebase:firebase-messaging:25.0.1")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
    implementation(project(":tauri-android"))
    testImplementation("junit:junit:4.13.2")
    // android.jar only stubs org.json; unit tests need the real parser.
    testImplementation("org.json:json:20250517")
}
