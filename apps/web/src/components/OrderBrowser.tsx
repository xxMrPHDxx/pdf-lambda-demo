import { useState } from "react";
import type { Client, Order, OrderStatus } from "../types";
import { documentCount, money, orderTotal, supplierCount } from "../utils";

const ORDER_STATUSES: OrderStatus[] = ["confirmed", "paid", "packing", "shipped"];

interface Props {
  clients: Client[];
  clientId: string;
  onClientChange: (clientId: string) => void;
  orders: Order[];
  suppliers: string[];
  email: string;
  onEmailChange: (email: string) => void;
  selected: Set<string>;
  onSelectedChange: (selected: Set<string>) => void;
  submitting: boolean;
  onCreate: () => void;
  onMutate: (order: Order) => void;
  mutatingId?: string;
}

export function OrderBrowser({
  clients,
  clientId,
  onClientChange,
  orders,
  suppliers,
  email,
  onEmailChange,
  selected,
  onSelectedChange,
  submitting,
  onCreate,
  onMutate,
  mutatingId,
}: Props) {
  const [search, setSearch] = useState("");
  const [supplier, setSupplier] = useState("all");
  const [status, setStatus] = useState("all");

  const visible = orders.filter((order) => {
    if (supplier !== "all" && !order.items.some((item) => item.supplier === supplier)) {
      return false;
    }
    if (status !== "all" && order.status !== status) {
      return false;
    }
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return true;
    }
    const haystack = [
      order.id,
      order.customer.name,
      order.customer.email,
      ...order.items.map((item) => `${item.sku} ${item.description} ${item.supplier}`),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });

  const selectedOrders = orders.filter((order) => selected.has(order.id));
  const selectedDocs = selectedOrders.reduce((sum, order) => sum + documentCount(order), 0);
  const allVisibleSelected = visible.length > 0 && visible.every((order) => selected.has(order.id));
  const client = clients.find((entry) => entry.id === clientId);

  const toggle = (orderId: string) => {
    const next = new Set(selected);
    if (next.has(orderId)) {
      next.delete(orderId);
    } else {
      next.add(orderId);
    }
    onSelectedChange(next);
  };

  const toggleVisible = () => {
    const next = new Set(selected);
    if (allVisibleSelected) {
      visible.forEach((order) => next.delete(order.id));
    } else {
      visible.forEach((order) => next.add(order.id));
    }
    onSelectedChange(next);
  };

  return (
    <section className="panel order-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">01 / Selection</div>
          <h2>Order library</h2>
          <p className="panel-sub">
            {orders.length} orders for {client?.name ?? clientId}. Revision and status are part of
            every cache key.
          </p>
        </div>
        <div className="client-tabs" role="tablist" aria-label="Clients">
          {clients.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === clientId}
              className={`client-tab ${entry.id === clientId ? "active" : ""}`}
              onClick={() => onClientChange(entry.id)}
              title={`${entry.name} — ${entry.email}`}
            >
              <span>{entry.initials}</span>
              {entry.name.split(" ")[0]}
            </button>
          ))}
        </div>
      </div>

      <div className="order-toolbar">
        <div className="search-field">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="M13 13l4 4" />
          </svg>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search order, customer, SKU..."
            aria-label="Search orders"
          />
        </div>
        <select
          value={supplier}
          onChange={(event) => setSupplier(event.target.value)}
          aria-label="Filter by supplier"
        >
          <option value="all">All suppliers</option>
          {suppliers.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="Filter by status"
        >
          <option value="all">Any status</option>
          {ORDER_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button type="button" className="ghost-button" onClick={toggleVisible}>
          {allVisibleSelected ? "Clear visible" : "Select visible"}
        </button>
      </div>

      <div className="table-wrap">
        <table className="order-table">
          <thead>
            <tr>
              <th className="check-cell" aria-label="Select" />
              <th>Order</th>
              <th>Customer</th>
              <th>Pack</th>
              <th>Status</th>
              <th className="right">Value</th>
              <th aria-label="Simulate change" />
            </tr>
          </thead>
          <tbody>
            {visible.map((order) => {
              const isSelected = selected.has(order.id);
              return (
                <tr
                  key={order.id}
                  className={isSelected ? "selected" : ""}
                  onClick={(event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest("button, input, a, select, label")) {
                      return;
                    }
                    toggle(order.id);
                  }}
                >
                  <td className="check-cell">
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(order.id)}
                        aria-label={`Select order ${order.id}`}
                      />
                      <span />
                    </label>
                  </td>
                  <td>
                    <div className="order-id">{order.id}</div>
                    <div className="order-meta">
                      <span className="rev">rev {order.rev}</span>
                      <span>{new Date(order.placedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</span>
                    </div>
                  </td>
                  <td>
                    <div className="customer">{order.customer.name}</div>
                    <div className="order-meta">{order.customer.address}</div>
                  </td>
                  <td>
                    <div className="pack-count">
                      {order.items.length} items · {supplierCount(order)} supplier
                      {supplierCount(order) === 1 ? "" : "s"}
                    </div>
                    <div className="supplier-mini">
                      {order.items[0]?.supplier}
                      {supplierCount(order) > 1 ? ` +${supplierCount(order) - 1}` : ""}
                    </div>
                  </td>
                  <td>
                    <span className={`order-status order-status-${order.status}`}>{order.status}</span>
                  </td>
                  <td className="right mono">{money(order.currency, orderTotal(order))}</td>
                  <td className="right">
                    <button
                      type="button"
                      className={`icon-button ${mutatingId === order.id ? "busy" : ""}`}
                      title="Simulate an external edit: bump revision, status and quantity"
                      aria-label={`Simulate external change for ${order.id}`}
                      onClick={() => onMutate(order)}
                      disabled={mutatingId === order.id}
                    >
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M15.4 7.2a6 6 0 1 0 .4 4.3" />
                        <path d="M15.5 3v4.5H11" />
                      </svg>
                    </button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <div className="table-empty">No orders match those filters.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="generate-bar">
        <div className="selection-summary">
          <div className="selection-count">
            <strong>{selected.size}</strong> order{selected.size === 1 ? "" : "s"}
          </div>
          <div className="selection-sub">
            {selectedDocs} PDFs · fanned out across SQS batches
          </div>
        </div>
        <label className="email-field">
          <span>Notify</span>
          <input
            type="email"
            value={email}
            onChange={(event) => onEmailChange(event.target.value)}
            placeholder="ops@example.com"
            aria-label="Notification email"
          />
        </label>
        <button
          type="button"
          className="primary-button"
          onClick={onCreate}
          disabled={submitting || selected.size === 0 || !email}
        >
          {submitting ? "Queueing..." : `Generate ${selected.size || ""} PDF pack${selected.size === 1 ? "" : "s"}`}
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4 10h11M10 4.5 15.5 10 10 15.5" />
          </svg>
        </button>
      </div>
    </section>
  );
}
