/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PLATFORM?: "wavedash" | "tommyato";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
