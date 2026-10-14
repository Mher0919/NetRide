package com.netride.rider.rider_flutter

// flutter_stripe requires the host Activity to be a FlutterFragmentActivity
// (its PaymentSheet/config entry point hosts a fragment). Extending the
// plain FlutterActivity breaks Stripe initialization with
// "not a subclass FlutterFragmentActivity".
import io.flutter.embedding.android.FlutterFragmentActivity

class MainActivity : FlutterFragmentActivity()
