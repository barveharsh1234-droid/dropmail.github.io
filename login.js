// JavaScript, public/login.js, login page runtime
"use strict";
(function () {
  const form = document.getElementById("login-form");
  const err = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");
  const btnText = document.getElementById("login-btn-text");
  const input = document.getElementById("password");

  function showError(msg) {
    err.textContent = msg;
    err.classList.remove("hidden");
  }
  function hideError() { err.classList.add("hidden"); }

  input.addEventListener("input", hideError);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError();
    btn.disabled = true;
    btnText.textContent = "Signing in…";
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: input.value })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showError(data.error || "Login failed.");
        btn.disabled = false;
        btnText.textContent = "Sign in";
        input.select();
        return;
      }
      // Auth succeeded — go to the dashboard.
      window.location.href = "/";
    } catch (ex) {
      showError("Network error. Check your connection and try again.");
      btn.disabled = false;
      btnText.textContent = "Sign in";
    }
  });
})();
