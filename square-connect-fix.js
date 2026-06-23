(() => {
  document.addEventListener("DOMContentLoaded", () => {
    const button = document.querySelector("#square-connect");
    if (!button) return;

    const cleanButton = button.cloneNode(true);
    button.replaceWith(cleanButton);
    cleanButton.addEventListener("click", connectSquare);
  });

  async function connectSquare(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const status = document.querySelector("#square-status-copy");
    try {
      const response = await fetch("/api/square/oauth-url", { cache: "no-store" });
      const data = await response.json();
      if (!data.url) throw new Error("Square OAuth URL was missing from the server response");

      const parsed = new URL(data.url);
      if (parsed.hostname !== "connect.squareupsandbox.com" && parsed.hostname !== "connect.squareup.com") {
        throw new Error("Unexpected Square OAuth host: " + parsed.hostname);
      }

      window.location.href = data.url;
    } catch (error) {
      console.error("[square-connect-fix] failed", error);
      if (status) status.textContent = error.message || "Could not start Square connection";
    }
  }
})();
