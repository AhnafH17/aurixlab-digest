import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const server = new McpServer({ name: 'aurixlab-mcp', version: '1.0.0' });

// ── Tool 1: get_team_workload ─────────────────────────────────────────────
server.tool(
  'get_team_workload',
  "Fetches full task data per team member: active counts, done counts, urgent tasks, overdue tasks, and tasks due within 2 days.",
  {},
  async () => {
    const client = await pool.connect();
    try {
      const usersResult = await client.query(
        `SELECT id, name, username FROM users WHERE disabled = false ORDER BY name ASC`
      );
      const users = usersResult.rows;

      // Active tasks (not done, not deleted)
      const activeResult = await client.query(
        `SELECT id, title, priority, due_date, status, assignee_id, assignee_ids
         FROM tasks
         WHERE done_date IS NULL AND deleted_at IS NULL`
      );

      // Done tasks (have a done_date, not deleted)
      const doneResult = await client.query(
        `SELECT id, assignee_id, assignee_ids
         FROM tasks
         WHERE done_date IS NOT NULL AND deleted_at IS NULL`
      );

      const now = new Date();
      const fiveDaysFromNow = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

      // Helper: resolve assignees from a task row
      const getAssigneeIds = (task) => {
        const ids = [];
        if (task.assignee_id) ids.push(task.assignee_id);
        const multi = Array.isArray(task.assignee_ids)
          ? task.assignee_ids
          : typeof task.assignee_ids === 'string' && task.assignee_ids !== '[]'
          ? JSON.parse(task.assignee_ids)
          : [];
        for (const id of multi) {
          if (!ids.includes(id)) ids.push(id);
        }
        return ids;
      };

      // Build per-user maps
      const userMap = {};
      for (const user of users) {
        userMap[user.id] = {
          name: user.name,
          username: user.username,
          activeTasks: [],
          doneTasks: 0,
        };
      }

      for (const task of activeResult.rows) {
        for (const uid of getAssigneeIds(task)) {
          if (userMap[uid]) {
            userMap[uid].activeTasks.push({
              title: task.title,
              priority: task.priority,
              dueDate: task.due_date ? new Date(task.due_date) : null,
            });
          }
        }
      }

      for (const task of doneResult.rows) {
        for (const uid of getAssigneeIds(task)) {
          if (userMap[uid]) {
            userMap[uid].doneTasks++;
          }
        }
      }

      const totalActive = Object.values(userMap).reduce((sum, u) => sum + u.activeTasks.length, 0);
      const activeMembers = Object.values(userMap).filter(u => u.activeTasks.length > 0);
      const avgTasks = activeMembers.length > 0 ? totalActive / activeMembers.length : 0;

      const workload = Object.values(userMap)
        .map((data) => {
          const active = data.activeTasks;
          const count = active.length;
          const pct = totalActive > 0 ? ((count / totalActive) * 100).toFixed(1) : '0.0';

          // Bottleneck: carrying more than 2x the average workload
          const isBottleneck = count > 0 && avgTasks > 0 && count >= avgTasks * 2;

          const urgentTasks = active
            .filter(t => t.priority === 'URGENT')
            .map(t => ({
              title: t.title,
              dueDate: t.dueDate ? t.dueDate.toISOString().split('T')[0] : null,
            }));

          const overdueTasks = active
            .filter(t => t.dueDate && t.dueDate < now)
            .map(t => ({
              title: t.title,
              dueDate: t.dueDate.toISOString().split('T')[0],
            }));

          const dueSoonTasks = active
            .filter(t => t.dueDate && t.dueDate >= now && t.dueDate <= fiveDaysFromNow)
            .map(t => ({
              title: t.title,
              dueDate: t.dueDate.toISOString().split('T')[0],
            }));

          return {
            name: data.name,
            username: data.username,
            activeTasks: count,
            doneTasks: data.doneTasks,
            workloadPercent: pct,
            isBottleneck,
            urgentTasks,
            overdueTasks,
            dueSoonTasks,
          };
        })
        .sort((a, b) => b.activeTasks - a.activeTasks);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ totalActiveTasks: totalActive, workload }, null, 2),
        }],
      };
    } finally {
      client.release();
    }
  }
);

// ── Tool 2: post_discord_summary ─────────────────────────────────────────
server.tool(
  'post_discord_summary',
  'Posts the formatted daily digest message to the Aurixlab Discord webhook.',
  { message: z.string().describe('The full formatted Discord markdown message to post') },
  async ({ message }) => {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl || webhookUrl.includes('PASTE_YOUR')) {
      throw new Error('DISCORD_WEBHOOK_URL is not configured in claude_desktop_config.json');
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, username: 'Aurixlab Digest' }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord webhook failed: ${response.status} — ${body}`);
    }

    return { content: [{ type: 'text', text: 'Discord message posted successfully.' }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
