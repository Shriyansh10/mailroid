# Mailroid 🦉

> AI-Powered Executive Assistant for Gmail & Google Calendar

Mailroid is a workflow-first email and calendar management platform built using Next.js, PostgreSQL, Corsair, and AI.

Instead of cloning Gmail or Calendar, Mailroid focuses on reducing cognitive load by automatically prioritizing important communications, generating executive briefings, enabling natural language actions, and providing lightning-fast search across your inbox and schedule.

Built for the ChaiCode × Corsair Hackathon.

---

## Demo

### Live Application
[Add Deployment URL]

### GitHub Repository
[Add GitHub Repository URL]

### Demo Video
[Add Demo Video URL]

### LinkedIn Post
[Add LinkedIn Post URL]

### X / Twitter Post
[Add Twitter Post URL]

---

# Problem

Modern email and calendar tools are built around message management rather than decision management.

Users spend significant time:

- Sorting important emails from noise
- Searching through old conversations
- Managing meetings and schedules
- Switching between Gmail and Calendar
- Performing repetitive actions

Even premium products focus on speed, but still require users to manually determine what matters.

Mailroid solves this by acting as an AI-powered executive assistant.

---

# Solution

Mailroid combines:

- Gmail
- Google Calendar
- AI prioritization
- Executive briefings
- Local semantic search
- Natural language workflows

into a single workflow-focused experience.

The system automatically:

- Syncs emails
- Syncs calendar events
- Prioritizes messages
- Generates executive summaries
- Stores embeddings for semantic retrieval
- Provides AI-powered actions

---

# Core Features

## 1. Gmail Integration

Powered by Corsair Gmail SDK.

Features:

- OAuth authentication
- Inbox synchronization
- Thread view
- Email search
- Send emails
- Local caching of messages
- Categorized inbox views

Mailroid fetches email data through Corsair and stores relevant metadata locally for faster retrieval.

---

## 2. Google Calendar Integration

Powered by Corsair Google Calendar SDK.

Features:

- Calendar synchronization
- Upcoming events dashboard
- Create events
- Update events
- Delete events
- Meeting visibility from unified dashboard

Users can manage schedules without switching applications.

---

## 3. Priority Inbox

One of Mailroid's primary workflow improvements.

Instead of chronological sorting, emails are ranked using AI.

Every email receives:

- Priority Level
  - HIGH
  - MEDIUM
  - LOW

- Priority Score
  - 0 – 100

- AI-generated reasoning

Example:

High Priority:
- Manager requests
- Meeting changes
- Time-sensitive communication

Low Priority:
- Promotions
- Marketing emails
- Newsletters

This dramatically reduces inbox triage time.

---

## 4. Executive Briefing

Mailroid generates an executive summary of:

### Inbox

- Important emails
- Urgent follow-ups
- New conversations

### Calendar

- Upcoming meetings
- Scheduling conflicts
- Important events

Users can understand their day within seconds.

---

## 5. AI Assistant

Natural language interface for productivity workflows.

Examples:

### Email Actions

```text
Send an email to john@example.com saying I will join tomorrow's meeting.
```

### Calendar Actions

```text
Create a meeting next Thursday at 9 AM with Rahul.
```

### Search Actions

```text
Find emails discussing quarterly revenue.
```

The assistant routes requests to underlying Gmail and Calendar tools.

---

## 6. Local Email Search

Mailroid stores email content locally.

Benefits:

- Faster search
- Reduced API dependency
- Better scalability
- Foundation for semantic retrieval

Two search modes:

### Quick Search

Local database lookup.

### Deep Search

Direct Gmail search through Corsair.

---

## 7. Semantic Search (Vector Search)

Mailroid stores embeddings for emails using pgvector.

This allows users to search conceptually instead of relying on exact keywords.

Example:

Query:

```text
emails about delayed payments
```

Results may include:

```text
invoice overdue
payment pending
awaiting transfer
```

without requiring exact phrase matches.

---

## 8. Unified Command Workflow

Mailroid is designed around actions rather than navigation.

Future workflows include:

```text
Email Rahul and schedule a meeting tomorrow.
```

```text
Summarize everything important from this week.
```

```text
Show emails related to tomorrow's meetings.
```

---

# Workflow Improvements Over Traditional Email Clients

Traditional email clients focus on:

- Message management
- Folder organization
- Manual filtering

Mailroid focuses on:

- Priority detection
- Decision support
- Executive summaries
- Semantic retrieval
- AI-assisted actions

The goal is to reduce attention spent managing communication.

---

# Tech Stack

## Frontend

- Next.js 15
- React
- TypeScript
- Tailwind CSS
- Fable UI Components

## Backend

- Express.js
- tRPC
- TypeScript

## Database

- PostgreSQL
- Drizzle ORM
- pgvector

## Authentication

- BetterAuth
- Google OAuth

## AI

- OpenAI Embeddings
- LLM-based Prioritization
- AI Executive Briefing

## Integrations

- Corsair Gmail
- Corsair Google Calendar

---

# Architecture

```text
┌─────────────────────────────┐
│         Frontend            │
│        Next.js App          │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│            tRPC             │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│        Express API          │
└─────────────┬───────────────┘
              │
      ┌───────┴────────┐
      ▼                ▼
┌─────────────┐ ┌─────────────┐
│   Corsair   │ │ AI Engine   │
└──────┬──────┘ └──────┬──────┘
       ▼               ▼
 Gmail/Calendar    Embeddings
       │               │
       └──────┬────────┘
              ▼
       PostgreSQL
         pgvector
```

---

# Database Highlights

## Emails Table

Stores:

- Message ID
- Thread ID
- Subject
- Sender
- Recipients
- Snippet
- Body
- Priority
- Priority Score
- Embedding Vector

---

## Calendar Events

Stores:

- Event ID
- Title
- Description
- Start Time
- End Time
- Attendees

---

# AI Pipeline

## Email Processing

```text
Email Received
      ↓
Store Metadata
      ↓
Generate Priority
      ↓
Generate Embedding
      ↓
Save To Database
      ↓
Available For Search
```

---

## Executive Briefing Pipeline

```text
Emails
     ↓
Calendar Events
     ↓
Priority Extraction
     ↓
AI Summary
     ↓
Executive Briefing
```

---

# Corsair Features Used

## Mandatory Features

✅ Gmail Integration

✅ Google Calendar Integration

---

## Additional Corsair Usage

✅ OAuth Flow

✅ Message Synchronization

✅ Calendar Synchronization

✅ Local Data Caching

✅ Search APIs

---

# Bonus Features Attempted

## AI Assistant

Natural language execution of email and calendar actions.

Status: Implemented

---

## Priority Inbox

AI-based ranking system.

Status: Implemented

---

## Executive Briefing

Daily intelligent summary.

Status: Implemented

---

## Local Search

Fast database-powered retrieval.

Status: Implemented

---

## Semantic Search

Embedding infrastructure using pgvector.

Status: Implemented

---

## Real-Time Webhooks

Gmail and Calendar updates.

Status: Implemented / In Progress (depending on final submission state)

---

# Project Structure

```text
apps/
├── web/
├── api/

packages/
├── ai/
├── corsair/
├── database/
├── services/
├── trpc/
├── logger/
```

---

# Local Development

## Clone Repository

```bash
git clone <repo-url>
cd mailroid
```

---

## Install Dependencies

```bash
pnpm install
```

---

## Configure Environment

Create:

```bash
.env
```

Required variables:

```env
DATABASE_URL=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

BETTER_AUTH_SECRET=

OPENAI_API_KEY=

CORSAIR_SECRET_KEY=
```

---

## Start PostgreSQL

```bash
docker compose up -d
```

---

## Run Migrations

```bash
pnpm db:migrate
```

---

## Start Development Servers

```bash
pnpm dev
```

---

# Future Roadmap

## Agent Workflows

```text
Send meeting invite and email attendees.
```

```text
Prepare agenda from previous email threads.
```

```text
Reschedule conflicting meetings automatically.
```

---

## Smart Follow-Ups

Automatically identify:

- unanswered emails
- pending approvals
- action items

---

## Meeting Intelligence

- AI agendas
- AI notes
- AI follow-up generation

---

## Cross-Application Knowledge Graph

Connect:

- emails
- meetings
- contacts
- projects

into a unified searchable workspace.

---

# Why Mailroid?

Most inbox tools help users process email faster.

Mailroid helps users decide what deserves attention.

By combining Gmail, Calendar, AI prioritization, semantic search, and executive briefings, Mailroid transforms communication management into a decision-support system.

---

## Built For

ChaiCode × Corsair Hackathon

Builder Mode On | MacBook Giveaway Hackathon

#chaicode #corsair-dev