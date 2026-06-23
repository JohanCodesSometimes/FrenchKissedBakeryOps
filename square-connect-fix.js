(() => {
  const allowedHosts = new Set(["connect.squareupsandbox.com", "connect.squareup.com"]);

  document.addEventListener("DOMContentLoaded", () => {
    const button = document.querySelector("#square-connect");
    if (!button) return;

    const cleanButton = button.cloneNode(true);
    button.replaceWith(cleanButton);
    cleanButton.addEventListener("click", connectSquare, { capture: true });
  });

  async function connectSquare(event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Connecting...";

    try {
      const response = await fetch("/api/square/oauth-url?ts=" + Date.now(), { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.url) throw new Error(data.error || "Could not start Square connection");

      console.log("[square-final] URL:", data.url);
      const oauthUrl = new URL(data.url);
      if (!allowedHosts.has(oauthUrl.hostname)) {
        window.alert("Unexpected Square OAuth host: " + oauthUrl.hostname);
        button.textContent = originalText;
        button.disabled = false;
        return;
      }

      window.location.replace(data.url);
    } catch (error) {
      window.alert(error.message || "Could not start Square connection");
      button.textContent = originalText;
      button.disabled = false;
    }
  }
})();
