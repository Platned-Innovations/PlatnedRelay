import { Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  AppWindow,
  BarChart3,
  Bell,
  Boxes,
  ChevronDown,
  FileClock,
  FileText,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Network,
  PiggyBank,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  TerminalSquare,
  User,
  Users,
  Waypoints,
  Zap,
} from 'lucide-react';
import { useAuth } from '../auth';
import { setThemePref, useTheme, type ThemePref } from '../theme';
import { Badge, Loading } from './ui';

const NAV: { title: string; items: { to: string; label: string; icon: typeof Activity; end?: boolean }[] }[] = [
  {
    title: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/reports', label: 'Reports', icon: BarChart3 },
      { to: '/requests', label: 'Requests', icon: Activity },
    ],
  },
  {
    title: 'Access',
    items: [
      { to: '/apps', label: 'Apps', icon: AppWindow },
      { to: '/entities', label: 'Entities', icon: Boxes },
      { to: '/keys', label: 'API keys', icon: KeyRound },
    ],
  },
  {
    title: 'Models',
    items: [
      { to: '/providers', label: 'Providers', icon: Server },
      { to: '/models', label: 'Models & pricing', icon: Network },
      { to: '/routes', label: 'Routes', icon: Waypoints },
      { to: '/prompts', label: 'Prompts', icon: FileText },
    ],
  },
  {
    title: 'Policies',
    items: [
      { to: '/guardrails', label: 'Guardrails', icon: ShieldCheck },
      { to: '/budgets', label: 'Spend caps', icon: PiggyBank },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/users', label: 'Users', icon: Users },
      { to: '/audit', label: 'Audit log', icon: FileClock },
      { to: '/notifications', label: 'Notifications', icon: Bell },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
  { title: 'Tools', items: [{ to: '/playground', label: 'Playground', icon: TerminalSquare }] },
];

function ThemeToggle() {
  const { pref } = useTheme();
  const order: ThemePref[] = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(pref) + 1) % order.length];
  const Icon = pref === 'dark' ? Moon : pref === 'light' ? Sun : Monitor;
  return (
    <button className="btn btn-ghost btn-icon" title={`Theme: ${pref} (click for ${next})`} aria-label={`Theme: ${pref}`} onClick={() => setThemePref(next)}>
      <Icon size={16} />
    </button>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  if (!user) return null;
  const initials = (user.name || user.username)
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="user-chip" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="avatar">{initials}</span>
        <span className="hide-sm">{user.username}</span>
        <Badge tone={user.role === 'owner' ? 'info' : user.role === 'admin' ? 'success' : 'neutral'}>{user.role}</Badge>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <div className="cell-title">{user.name}</div>
            <div className="cell-sub">{user.email}</div>
          </div>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              navigate('/profile');
            }}
          >
            <User size={15} /> Profile & security
          </button>
          <button
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const [navOpen, setNavOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setNavOpen(false), [loc.pathname]);
  return (
    <div className={`shell${navOpen ? ' nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <span className="brand-mark">
            <Zap size={15} />
          </span>
          Relay
          <small>LLM gateway</small>
        </div>
        <nav className="nav">
          {NAV.map((g) => (
            <div className="nav-group" key={g.title}>
              <div className="nav-group-title">{g.title}</div>
              {g.items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.end}>
                  <i.icon size={16} />
                  {i.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />
      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-icon menu-btn" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
            <Menu size={18} />
          </button>
          <span className="muted small hide-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Gauge size={14} /> Admin console
          </span>
          <div className="spacer" />
          <ThemeToggle />
          <UserMenu />
        </header>
        <main className="content">
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
