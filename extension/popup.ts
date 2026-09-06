const status = document.querySelector<HTMLElement>("#status")!;
const form = document.querySelector<HTMLFormElement>("#pair")!;
const port = document.querySelector<HTMLInputElement>("#port")!;
const forget = document.querySelector<HTMLButtonElement>("#forget")!;
let initialized = false;
let refreshing = false;
async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    status.textContent = result.authenticated ? (result.session ? "Connected · tab armed" : "Connected · no tab armed")
      : result.issue ?? (result.paired ? "Paired · daemon disconnected. Start why-ui mcp or reconnect." : "Not paired. Run why-ui pair and enter its token.");
    form.hidden = result.paired; forget.hidden = !result.paired;
    if (!initialized) {
      port.value = String(result.port); initialized = true;
      document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(control => { control.disabled = false; });
    }
  } catch { status.textContent = "Extension unavailable. Reopen its settings."; }
  finally { refreshing = false; }
}
async function send(type: string, fields: Record<string, unknown> = {}): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ type, ...fields });
    if (result?.ok === false) status.textContent = "Invalid pairing token or port. Check the local daemon settings.";
    else await refresh();
  } catch { status.textContent = "Extension unavailable. Reopen its settings."; }
}
form.addEventListener("submit", event => {
  event.preventDefault();
  const token = document.querySelector<HTMLInputElement>("#token")!;
  void send("PAIR_TOKEN", { token: token.value.trim(), port: Number(port.value) });
  token.value = "";
});
document.querySelector("#disarm")!.addEventListener("click", () => void send("DISARM_TAB"));
document.querySelector("#connect")!.addEventListener("click", () => void send("RECONNECT_BRIDGE", { port: Number(port.value) }));
forget.addEventListener("click", () => void send("FORGET_PAIRING"));
void refresh();
setInterval(() => void refresh(), 1000);
