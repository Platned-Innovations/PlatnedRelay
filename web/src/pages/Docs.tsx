import { useEffect, useMemo, useRef } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { BookOpen, ArrowLeft } from 'lucide-react';
import { useAuth } from '../auth';

/**
 * Relay documentation, rendered from the repository's docs/*.md at build time
 * (single source of truth). Public: integrators can read it without an admin account.
 */
const files = import.meta.glob('../../../docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const ORDER = [
  'README', 'getting-started', 'api', 'admin-guide', 'providers', 'configuration', 'security',
  'architecture', 'scaling', 'deployment-docker', 'deployment-azure', 'operations', 'admin-api', 'roadmap',
];

interface Doc {
  slug: string;
  title: string;
  markdown: string;
}

const DOCS: Doc[] = Object.entries(files)
  .map(([path, markdown]) => {
    const name = path.split('/').pop()!.replace(/\.md$/, '');
    const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? name;
    return { slug: name === 'README' ? '' : name, title: name === 'README' ? 'Overview' : title, markdown, order: ORDER.indexOf(name) };
  })
  .sort((a, b) => (a.order < 0 ? 99 : a.order) - (b.order < 0 ? 99 : b.order))
  .map(({ slug, title, markdown }) => ({ slug, title, markdown }));

const slugifyHeading = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

const marked = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      return `<h${depth} id="${slugifyHeading(text)}">${text}</h${depth}>\n`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      let target = href ?? '';
      // Links between docs (e.g. "security.md#rotation", "docs/api.md") stay inside the app.
      const m = target.match(/^(?:\.\/)?(?:docs\/)?([\w-]+)\.md(#.*)?$/);
      if (m) target = `/docs${m[1] === 'README' ? '' : `/${m[1]}`}${m[2] ?? ''}`;
      const external = /^https?:\/\//.test(target);
      const t = title ? ` title="${title}"` : '';
      return `<a href="${target}"${t}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
    },
  },
});

export default function Docs() {
  const { slug = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);
  const doc = DOCS.find((d) => d.slug === slug);

  const html = useMemo(() => (doc ? DOMPurify.sanitize(marked.parse(doc.markdown) as string, { ADD_ATTR: ['target'] }) : ''), [doc]);

  useEffect(() => {
    document.title = doc ? `${doc.title} · Relay docs` : 'Relay docs';
  }, [doc]);

  // Scroll to the anchor (or top) after navigation.
  useEffect(() => {
    const id = decodeURIComponent(loc.hash.slice(1));
    const el = id ? document.getElementById(id) : null;
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash, html]);

  // Internal links: client-side navigation instead of full page loads.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!a || !href || a.target === '_blank' || e.metaKey || e.ctrlKey) return;
    if (href.startsWith('/docs') || href.startsWith('#')) {
      e.preventDefault();
      navigate(href.startsWith('#') ? `${loc.pathname}${href}` : href);
    }
  };

  if (!doc) return <Navigate to="/docs" replace />;

  return (
    <div className="docs-shell">
      <header className="docs-top">
        <Link to="/docs" className="docs-brand">
          <BookOpen size={18} /> Relay documentation
        </Link>
        <Link to={user ? '/' : '/login'} className="btn btn-ghost btn-sm">
          <ArrowLeft size={14} /> {user ? 'Back to console' : 'Admin sign in'}
        </Link>
      </header>
      <div className="docs-body">
        <nav className="docs-nav" aria-label="Documentation">
          {DOCS.map((d) => (
            <Link key={d.slug} to={d.slug ? `/docs/${d.slug}` : '/docs'} className={d.slug === slug ? 'active' : undefined}>
              {d.title}
            </Link>
          ))}
        </nav>
        <article className="markdown" ref={contentRef} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
