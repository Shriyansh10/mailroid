export const metadata = {
  title: "Terms of Service | Mailroid",
};

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-4xl font-bold tracking-tight">Terms of Service</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: July 9, 2026</p>

        <div className="prose prose-neutral dark:prose-invert mt-10 max-w-none">
          <p>
            These Terms of Service ("Terms") govern your use of Mailroid, a productivity
            application that connects to your Gmail and Google Calendar accounts to provide
            AI-assisted email prioritization, summaries, search, and calendar sync. By creating an
            account or connecting your Google account, you agree to these Terms.
          </p>

          <h2>1. The Service</h2>
          <p>
            Mailroid reads and organizes data from Gmail and Google Calendar that you explicitly
            authorize via Google OAuth, and uses that data to provide features such as inbox
            prioritization, AI-generated briefings, search, and an AI chat assistant. Mailroid acts
            only within the scopes you grant and only in response to your use of the app.
          </p>

          <h2>2. Your Responsibilities</h2>
          <ul>
            <li>You must have the authority to connect the Google account(s) you link to Mailroid.</li>
            <li>You are responsible for keeping your account credentials secure.</li>
            <li>
              You agree not to use Mailroid to violate any law, Google's Terms of Service, or the
              rights of others.
            </li>
          </ul>

          <h2>3. AI-Generated Content</h2>
          <p>
            Features such as priority scoring, summaries, briefings, and chat responses are
            generated using third-party AI models. This content is provided for convenience and
            may occasionally be inaccurate or incomplete. You are responsible for verifying
            important information before acting on it (e.g. do not rely solely on an AI summary
            for time-sensitive or critical decisions).
          </p>

          <h2>4. Availability</h2>
          <p>
            Mailroid is provided on an "as is" and "as available" basis. We do not guarantee
            uninterrupted or error-free operation, and features may change, be added, or be
            removed as the product evolves.
          </p>

          <h2>5. Data and Privacy</h2>
          <p>
            Our handling of your data is described in the{" "}
            <a href="/privacy">Privacy Policy</a>, which is incorporated into these Terms by
            reference.
          </p>

          <h2>6. Termination</h2>
          <p>
            You may stop using Mailroid and revoke its access to your Google account at any time
            via{" "}
            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
              Google Account Permissions
            </a>
            . We may suspend or terminate access to the Service for misuse or violation of these
            Terms.
          </p>

          <h2>7. Limitation of Liability</h2>
          <p>
            To the fullest extent permitted by law, Mailroid and its developer shall not be liable
            for any indirect, incidental, or consequential damages arising from your use of the
            Service, including reliance on AI-generated content.
          </p>

          <h2>8. Changes to These Terms</h2>
          <p>
            We may update these Terms from time to time. Continued use of Mailroid after changes
            are posted constitutes acceptance of the updated Terms.
          </p>

          <h2>9. Contact</h2>
          <p>
            Questions about these Terms can be sent to{" "}
            <a href="mailto:agarwalshriyansh007@gmail.com">agarwalshriyansh007@gmail.com</a>.
          </p>
        </div>
      </div>
    </div>
  );
}
