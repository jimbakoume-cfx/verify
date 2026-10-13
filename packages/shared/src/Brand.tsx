import logoMark from "../assets/logo-mark.svg";

/** Small Confiance mark + product name, for the top bar. */
export function Brand({ product }: { product: string }) {
  return (
    <span className="brand">
      <img src={logoMark} alt="" />
      {product}
    </span>
  );
}
