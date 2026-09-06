import * as React from "react";
import { createRoot } from "react-dom/client";

const targetStyle = {
  position: "absolute", left: 100, top: 100, width: 200, height: 100,
  border: 0, borderRadius: 0, padding: 0,
};

function PaymentButton() {
  return <button id="target" style={targetStyle}>
    {window.__fixtureScenario === "svg" && <svg
      id="payment-icon" viewBox="0 0 40 40" width="40" height="40"
      style={{ position: "absolute", left: 20, top: 30 }}
    ><path id="payment-path" d="M 0 0 H 40 V 40 H 0 Z" /></svg>}
    Pay
  </button>;
}

function CheckoutButton() {
  return <button id="target" style={targetStyle}>Pay</button>;
}

function ModalBackdrop() {
  return <div id="overlay" style={{
    ...targetStyle, zIndex: 10, background: "rgb(80, 80, 80)",
  }} />;
}

function Fixture() {
  React.useLayoutEffect(() => {
    window.__reactFixture = { version: React.version, ready: true };
  }, []);
  return window.__fixtureScenario === "overlay"
    ? <><CheckoutButton /><ModalBackdrop /></>
    : <PaymentButton />;
}

createRoot(document.getElementById("root")).render(<Fixture />);
