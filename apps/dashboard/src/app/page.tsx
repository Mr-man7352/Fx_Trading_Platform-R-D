import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ padding: '4rem', maxWidth: 640, margin: '0 auto' }}>
      <h1>FX Swing-Trading Platform</h1>
      <p>
        Phase 1 scaffold. Quant backbone first, LLM second — the deterministic risk gate holds final
        authority.
      </p>
      <p style={{ opacity: 0.7 }}>
        Invite-only. Own broker account only. CFDs are high-risk leveraged products.
      </p>
      <ul>
        <li>
          <Link href="/dashboard">Operator dashboard</Link>
        </li>
        <li>
          <Link href="/sign-in">Sign in</Link>
        </li>
      </ul>
    </main>
  );
}
