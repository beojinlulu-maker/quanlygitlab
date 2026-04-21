const firebaseConfig = {
  apiKey: "AIzaSyBvOcu9XetN4UyUMgAnXK3ZLW2N4nqfXQY",
  authDomain: "quanlygitlab.firebaseapp.com",
  projectId: "quanlygitlab",
  storageBucket: "quanlygitlab.firebasestorage.app",
  messagingSenderId: "33713560389",
  appId: "1:33713560389:web:747b17bfae3754cb503c2c",
  measurementId: "G-RWV2THCM0L"
};

// Initialize Firebase using compat syntax
if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
  firebase.analytics();
  window.db = firebase.firestore();
}

window.taskMetaMap = {};

window.loadAllTaskMetaFromFirestore = async function() {
    if (!window.db) return;
    try {
        const querySnapshot = await window.db.collection("taskMeta").get();
        querySnapshot.forEach((doc) => {
            window.taskMetaMap[doc.id] = doc.data();
        });
        console.log("Loaded all taskMeta from Firestore:", Object.keys(window.taskMetaMap).length);
    } catch (error) {
        console.error("Lỗi khi tải dữ liệu từ Firestore:", error);
    }
}
