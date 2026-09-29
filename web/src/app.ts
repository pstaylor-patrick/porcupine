export function appTitle(): string {
  return "Porcupine";
}

if (typeof document !== "undefined") {
  document.title = appTitle();
}
