import type { QuickLink } from "@/lib/types";

export const quickLinks = [
  { id: 1, label: "HR portal", url: "https://example.com/hr", icon: "Contact", order: 1 },
  { id: 2, label: "Expense tool", url: "https://example.com/expenses", icon: "Wallet", order: 2 },
  { id: 3, label: "IT helpdesk", url: "https://example.com/helpdesk", icon: "LifeBuoy", order: 3 },
  { id: 4, label: "Meeting rooms", url: "https://example.com/rooms", icon: "Calendar", order: 4 },
  { id: 5, label: "Status page", url: "https://status.example.com", icon: "Globe", order: 5 },
] satisfies QuickLink[];
