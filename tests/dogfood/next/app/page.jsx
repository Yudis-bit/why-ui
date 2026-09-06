'use client';
import styles from './checkout.module.css';
const blocked = true;
function ModalBackdrop() { return <div id="backdrop" className={styles.backdrop} />; }
export default function Checkout() {
  return <main><h1>Checkout</h1><p>Development-server interaction reproduction</p>
    <section className={styles.card}><button id="checkout" className={styles.button}>Pay $42</button></section>
    {blocked && <ModalBackdrop />}
  </main>;
}
