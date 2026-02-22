# Finance Admin Dashboard

A modern, glassmorphic finance tracking dashboard built with Next.js 15, Supabase, and Tailwind CSS. Track income sources, expenses, and net worth with a beautiful, responsive interface.

![Dashboard Preview](/.github/preview.png)

## Features

- **Income Tracking** - Manage multiple income sources and log monthly earnings
- **Expense Management** - Track personal and business expenses with categories
- **Net Worth Monitoring** - Visualize your financial growth over time
- **Privacy Mode** - Hide sensitive financial data with one click
- **Dark/Light Theme** - Switch between themes based on preference
- **Mobile Responsive** - Full functionality on all device sizes
- **Data Export** - Export your data as JSON or CSV
- **Trash Recovery** - Restore accidentally deleted items

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Database**: Supabase (PostgreSQL)
- **Auth**: Supabase Auth
- **Styling**: Tailwind CSS with glassmorphic design
- **Charts**: Recharts
- **UI Components**: Radix UI primitives
- **Icons**: Lucide React

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm (recommended) or npm
- Supabase account

### 1. Clone and Install

```bash
git clone https://github.com/ciaranmci27/valiance-media-personal-finance-tracker.git
cd valiance-media-personal-finance-tracker
pnpm install
```

### 2. Environment Setup

Copy the example environment file and fill in your Supabase credentials:

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

### 3. Database Setup

Run the following SQL in your Supabase SQL editor to create the required tables:

```sql
-- Income Sources
create table income_sources (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  color text,
  created_at timestamptz default now(),
  deleted_at timestamptz
);

-- Income Entries (monthly records)
create table income_entries (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  month date not null,
  notes text,
  created_at timestamptz default now(),
  deleted_at timestamptz
);

-- Income Amounts (per source per entry)
create table income_amounts (
  id uuid default gen_random_uuid() primary key,
  entry_id uuid references income_entries(id) on delete cascade not null,
  source_id uuid references income_sources(id) on delete cascade not null,
  amount decimal(12,2) not null default 0
);

-- Expenses
create table expenses (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  amount decimal(12,2) not null,
  category text check (category in ('personal', 'business')) not null,
  frequency text check (frequency in ('monthly', 'quarterly', 'annual')) not null,
  notes text,
  created_at timestamptz default now(),
  deleted_at timestamptz
);

-- Net Worth
create table net_worth (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  date date not null,
  amount decimal(12,2) not null,
  notes text,
  created_at timestamptz default now(),
  deleted_at timestamptz
);

-- Enable Row Level Security
alter table income_sources enable row level security;
alter table income_entries enable row level security;
alter table income_amounts enable row level security;
alter table expenses enable row level security;
alter table net_worth enable row level security;

-- RLS Policies (users can only access their own data)
create policy "Users can manage their own income sources"
  on income_sources for all using (auth.uid() = user_id);

create policy "Users can manage their own income entries"
  on income_entries for all using (auth.uid() = user_id);

create policy "Users can manage their own income amounts"
  on income_amounts for all using (
    entry_id in (select id from income_entries where user_id = auth.uid())
  );

create policy "Users can manage their own expenses"
  on expenses for all using (auth.uid() = user_id);

create policy "Users can manage their own net worth"
  on net_worth for all using (auth.uid() = user_id);
```

### 4. Run Development Server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to view the dashboard.

## Customization

### Branding Your Dashboard

To rebrand the dashboard for your company:

#### 1. Update Site Config

Edit `src/config/site.ts` with your company details:

```typescript
export const siteConfig = {
  name: "Your Company Name",
  shortName: "YourCo",
  description: "Internal finance dashboard",
  // ...
};
```

#### 2. Replace Logo Files

Replace these files in `public/` with your own logos:

| File | Purpose | Recommended Size |
|------|---------|------------------|
| `logos/horizontal-logo.png` | Light theme header logo | 280x64px |
| `logos/horizontal-logo-inverted.png` | Dark theme header logo | 280x64px |
| `favicon/android-chrome-192x192.png` | App icon, collapsed sidebar | 192x192px |
| `favicon/android-chrome-512x512.png` | Large app icon | 512x512px |
| `favicon/apple-touch-icon.png` | iOS home screen icon | 180x180px |
| `favicon/favicon-32x32.png` | Browser tab icon | 32x32px |
| `favicon/favicon-16x16.png` | Small browser icon | 16x16px |
| `favicon/favicon.ico` | Legacy favicon | Multi-size |

#### 3. Update Web Manifest

Edit `public/favicon/site.webmanifest`:

```json
{
  "name": "Your Company Name",
  "short_name": "YourCo",
  "icons": [...],
  "theme_color": "#5B8A8A",
  "background_color": "#F5F3EF",
  "display": "standalone"
}
```

#### 4. Update Theme Colors (Optional)

The dashboard uses these primary colors defined in `src/app/globals.css`:

- **Primary (Teal)**: `#5B8A8A` - Main accent color
- **Secondary (Copper)**: `#C5A68F` - Secondary accent
- **Background**: `#F5F3EF` - Light theme background

To change colors, update the CSS custom properties in `globals.css`.

### Adding New Features

The codebase follows a feature-based structure:

```
src/
├── app/                    # Next.js App Router pages
│   ├── (auth)/            # Auth pages (login)
│   └── (dashboard)/       # Protected dashboard pages
├── components/
│   ├── features/          # Feature-specific components
│   │   ├── dashboard/     # Dashboard widgets
│   │   ├── income/        # Income management
│   │   ├── expenses/      # Expense tracking
│   │   ├── net-worth/     # Net worth tracking
│   │   └── settings/      # Settings pages
│   ├── layout/            # Layout components (sidebar, header)
│   └── ui/                # Reusable UI primitives
├── config/                # Site configuration
├── contexts/              # React contexts
└── lib/                   # Utilities and Supabase client
```

## Deployment

### Vercel (Recommended)

1. Push your code to GitHub
2. Import the repository in Vercel
3. Set environment variables in Vercel dashboard
4. Deploy

### Other Platforms

The dashboard can be deployed to any platform supporting Next.js:

```bash
pnpm build
pnpm start
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - feel free to use this for your own projects.
