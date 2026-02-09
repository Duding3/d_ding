(function () {
  const config = {
    apiKey: "AIzaSyDcBZjWKH4AfA_xSCj4si3Ae9cfnl_d9Yc",
    authDomain: "ding-fed4c.firebaseapp.com",
    databaseURL: "https://ding-fed4c-default-rtdb.firebaseio.com/",
    projectId: "ding-fed4c",
    storageBucket: "ding-fed4c.firebasestorage.app",
    messagingSenderId: "892184739007",
    appId: "1:892184739007:web:8a76494cf4100492f9da0a",
    measurementId: "G-92DJLF04P9"
  };

  if (!window.firebase) {
    console.warn("firebase-config.js: Firebase SDK is not loaded.");
    return;
  }

  if (!firebase.apps.length) {
    firebase.initializeApp(config);
  }
})();
