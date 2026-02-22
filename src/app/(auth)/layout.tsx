export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      {/* Decorative background elements */}
      <div className="fixed inset-0 -z-10 overflow-hidden">
        {/* Gradient orbs */}
        <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-teal/20 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-copper/20 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-96 w-96 rounded-full bg-teal/10 blur-3xl" />
      </div>
      {children}
    </div>
  );
}
