// Lets TypeScript understand `import text from "./file.md?raw"` (Vite and our esbuild plugin inline the file as a string).
declare module "*?raw" {
  const content: string;
  export default content;
}
