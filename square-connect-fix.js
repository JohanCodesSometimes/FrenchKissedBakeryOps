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
    const button = event.currentTarget;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/square/oauth-url", { cache: "no-store" });
      const data = await response.json();
      if (!data.url) throw new Error("Square connection could not start");

      const parsed = new URL(data.url);
      if (parsed.hostname !== "connect.squareupsandbox.com" && parsed.hostname !== "connect.squareup.com") {
        throw new Error("Square connection could not start");
      }

      window.location.href = data.url;
    } catch (error) {
      console.error("[square] connection start failed", error);
      if (status) status.textContent = "Could not start the Square connection. Please try again.";
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
})();
