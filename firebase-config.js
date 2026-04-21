import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyBvOcu9XetN4UyUMgAnXK3ZLW2N4nqfXQY",
  authDomain: "quanlygitlab.firebaseapp.com",
  projectId: "quanlygitlab",
  storageBucket: "quanlygitlab.firebasestorage.app",
  messagingSenderId: "33713560389",
  appId: "1:33713560389:web:747b17bfae3754cb503c2c",
  measurementId: "G-RWV2THCM0L"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
