#!/usr/bin/env node
/**
 * Clincoo MCP Server
 * Memberikan akses ke API Clincoo (projects, agent, wallet, notifications)
 * lewat Model Context Protocol.
 *
 * Env yang dibutuhkan:
 *   CLINCOO_TOKEN     — Bearer token akun Clincoo (wajib)
 *   CLINCOO_BASE_URL  — Base URL API (default: https://muzawwied.github.io/Clincoo.)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.CLINCOO_BASE_URL || "https://muzawwied.github.io/Clincoo.").replace(/\/$/, "");
const TOKEN = process.env.CLINCOO_TOKEN || "";

if (!TOKEN) {
  console.error("[clincoo-mcp] Error: CLINCOO_TOKEN environment variable is required");
  process.exit(1);
}

async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const url = `${BASE_URL}${path.startsWith("/") ? path : "/" + path}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as any)?.error || (data as any)?.message || res.statusText;
    throw new Error(`Clincoo API ${res.status}: ${msg}`);
  }
  return data as T;
}

const server = new McpServer({
  name: "clincoo",
  version: "1.0.0",
});

// ─── get_me ───────────────────────────────────────────────────────────────
server.tool(
  "get_me",
  "Ambil info akun Clincoo yang sedang login (nama, email, role, status).",
  {},
  async () => {
    const data = await api<{ authenticated: boolean; user: any }>("/api/auth/me");
    if (!data.authenticated || !data.user) {
      return { content: [{ type: "text", text: "Tidak terautentikasi. Cek CLINCOO_TOKEN." }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data.user, null, 2) }],
    };
  }
);

// ─── list_projects ────────────────────────────────────────────────────────
server.tool(
  "list_projects",
  "Daftar semua proyek milik akun Clincoo yang login.",
  {},
  async () => {
    const data = await api<{ projects: any[] }>("/api/projects");
    const projects = data.projects || [];
    if (projects.length === 0) {
      return { content: [{ type: "text", text: "Belum ada proyek." }] };
    }
    const summary = projects.map((p) => ({
      id: p.id,
      title: p.title,
      aiName: p.aiName,
      updatedAt: p.updatedAt,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ─── get_wallet_balance ───────────────────────────────────────────────────
server.tool(
  "get_wallet_balance",
  "Ambil saldo dompet Clincoo (termasuk jika terhubung ClincooPay).",
  {},
  async () => {
    const data = await api<{ balance: number; mirrored?: boolean; wallet_address?: string }>("/api/wallet");
    const text = data.mirrored
      ? `Saldo (mirrored ClincooPay): Rp ${Number(data.balance).toLocaleString("id-ID")}\nWallet: ${data.wallet_address || "-"}`
      : `Saldo: Rp ${Number(data.balance).toLocaleString("id-ID")}`;
    return { content: [{ type: "text", text }] };
  }
);

// ─── list_wallet_transactions ─────────────────────────────────────────────
server.tool(
  "list_wallet_transactions",
  "Daftar riwayat transaksi dompet Clincoo (terbaru dulu).",
  {
    limit: z.number().int().min(1).max(50).optional().describe("Jumlah maksimal transaksi (default 20)"),
  },
  async ({ limit = 20 }) => {
    const data = await api<{ transactions: any[] }>("/api/wallet?action=transactions");
    const txs = (data.transactions || []).slice(0, limit);
    if (txs.length === 0) {
      return { content: [{ type: "text", text: "Belum ada transaksi." }] };
    }
    const summary = txs.map((t) => ({
      id: t.id,
      title: t.title,
      amount: t.amount,
      type: t.type,
      method: t.method,
      created_at: t.created_at,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ─── start_agent_task ─────────────────────────────────────────────────────
server.tool(
  "start_agent_task",
  "Mulai tugas Agent Mode Clincoo di latar belakang (background). Kembalikan task_id untuk dipantau.",
  {
    goal: z.string().min(3).describe("Tujuan tugas agent (bahasa Indonesia, jelas)"),
    project_id: z.string().optional().describe("ID proyek terkait (opsional)"),
    wa_number: z.string().optional().describe("Nomor WhatsApp untuk progress (opsional, format internasional)"),
  },
  async ({ goal, project_id, wa_number }) => {
    const body: Record<string, unknown> = {
      action: "start_bg",
      goal,
    };
    if (project_id) body.project_id = project_id;
    if (wa_number) body.wa_number = wa_number;

    const data = await api<{ ok: boolean; task: any; message?: string }>("/api/agent", {
      method: "POST",
      body,
    });

    return {
      content: [{
        type: "text",
        text: `Tugas agent dimulai.\nTask ID: ${data.task?.id}\nStatus: ${data.task?.status}\n${data.message || ""}\n\nPakai tool get_agent_status dengan task_id di atas untuk memantau progress.`,
      }],
    };
  }
);

// ─── get_agent_status ─────────────────────────────────────────────────────
server.tool(
  "get_agent_status",
  "Cek status dan progress tugas Agent Mode (termasuk events).",
  {
    task_id: z.string().describe("ID task agent (dari start_agent_task)"),
  },
  async ({ task_id }) => {
    const data = await api<{ ok: boolean; task: any; events?: any[] }>(`/api/agent?task_id=${encodeURIComponent(task_id)}`);
    const task = data.task;
    const events = data.events || [];

    const lines = [
      `Task ID   : ${task.id}`,
      `Status    : ${task.status}`,
      `Goal      : ${task.goal}`,
      `Step      : ${task.current_step}`,
      `Updated   : ${task.updated_at}`,
    ];
    if (task.error) lines.push(`Error     : ${task.error}`);
    if (task.result) lines.push(`\nHasil akhir:\n${String(task.result).slice(0, 2000)}`);

    if (events.length) {
      lines.push("\n--- Events ---");
      for (const e of events.slice(-15)) {
        lines.push(`[${e.kind}] ${e.text} (${e.created_at})`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── list_notifications ───────────────────────────────────────────────────
server.tool(
  "list_notifications",
  "Ambil notifikasi terbaru dari akun Clincoo.",
  {
    limit: z.number().int().min(1).max(50).optional().describe("Jumlah maksimal (default 15)"),
  },
  async ({ limit = 15 }) => {
    // Endpoint notifications biasanya GET /api/notifications
    const data = await api<{ notifications?: any[]; items?: any[] }>("/api/notifications");
    const list = data.notifications || data.items || (Array.isArray(data) ? data : []);
    const sliced = list.slice(0, limit);

    if (sliced.length === 0) {
      return { content: [{ type: "text", text: "Tidak ada notifikasi." }] };
    }

    const summary = sliced.map((n: any) => ({
      id: n.id,
      message: n.message || n.text,
      type: n.type || n.source,
      read: n.read ?? n.is_read,
      created_at: n.created_at || n.createdAt,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ─── Start server ─────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[clincoo-mcp] Server running on stdio");
}

main().catch((err) => {
  console.error("[clincoo-mcp] Fatal:", err);
  process.exit(1);
});
