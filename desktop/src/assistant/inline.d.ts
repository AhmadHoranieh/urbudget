/** A stylesheet imported as text with Vite's `?inline`, for documents outside the app's page. */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
