export function computeInvoiceTotal(lines: { qty: number; price: number }[]): number {
  return lines.reduce((s, l) => s + l.qty * l.price, 0);
}
export class InvoiceFormatter { format(total: number) { return `$${total.toFixed(2)}`; } }
