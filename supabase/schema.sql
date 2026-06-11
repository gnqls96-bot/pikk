create table if not exists trends (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  summary text not null,
  original_title text,
  category text not null check (category in ('푸드', '뷰티', 'SNS', '패션', '테크', '라이프', '디자인', '광고', '영상')),
  source_url text,
  image_url text,
  tags text[] default '{}',
  view_count integer default 0,
  created_at timestamptz default now(),
  published_at timestamptz default now()
);

create table if not exists waitlist (
  id uuid default gen_random_uuid() primary key,
  email text not null unique,
  created_at timestamptz default now()
);

-- RLS
alter table trends enable row level security;
alter table waitlist enable row level security;

create policy "trends are publicly readable" on trends
  for select using (true);

create policy "anyone can join waitlist" on waitlist
  for insert with check (true);

create policy "trends image_url is updatable" on trends
  for update using (true) with check (true);
