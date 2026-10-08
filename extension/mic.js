const msg = document.getElementById("msg");
document.getElementById("go").addEventListener("click", async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    msg.className = "ok";
    msg.textContent = "✓ Done. Go back to your page and tap SayIt again. This tab will close by itself.";
    chrome.storage.local.set({ micGranted: true });
    setTimeout(() => window.close(), 2500);
  } catch (e) {
    msg.className = "bad";
    msg.textContent = "Chrome blocked it. Click the icon on the left of the address bar, set Microphone to Allow, then press the button again.";
  }
});
