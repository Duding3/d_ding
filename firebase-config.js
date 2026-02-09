// Firebase Configuration
// 아래의 설정을 Firebase 콘솔에서 복사한 내용으로 교체해주세요.
const firebaseConfig = {
  apiKey: "AIzaSyAckQZKKVmsy23iAp_xxrAD-j-BcmT-etU",
  authDomain: "dingding-bcf1b.firebaseapp.com",
  projectId: "dingding-bcf1b",
  storageBucket: "dingding-bcf1b.firebasestorage.app",
  messagingSenderId: "831618245971",
  appId: "1:831618245971:web:4017491904c7514af02da6",
  measurementId: "G-M627F2PZKZ",
  databaseURL: "https://dingding-bcf1b-default-rtdb.firebaseio.com"
};

// Initialize Firebase
if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
  var database = firebase.database();
} else {
  console.error("Firebase SDK가 로드되지 않았습니다.");
}
