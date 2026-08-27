package io.crates.keyring

import android.content.Context

class Keyring private constructor() {
  companion object {
    init {
      System.loadLibrary("station_ai_lib")
    }

    external fun initializeNdkContext(context: Context)
  }
}
