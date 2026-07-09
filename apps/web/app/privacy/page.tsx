export const metadata = {
  title: "Privacy Policy | Mailroid",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-4xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: July 9, 2026</p>

        <div className="prose prose-neutral dark:prose-invert mt-10 max-w-none">
          <p>
            Mailroid ("we", "our", "us") provides an AI-powered productivity layer on top of
            Gmail and Google Calendar. This policy explains what data we access, why we access
            it, and how it is stored and used.
          </p>

          <h2>1. Information We Access</h2>
          <p>When you connect your Google account, Mailroid requests access to:</p>
          <ul>
            <li>
              <strong>Your basic profile</strong> — name, email address, and profile picture, used
              to identify your account.
            </li>
            <li>
              <strong>Gmail messages and metadata</strong> — subject lines, senders, timestamps,
              and message content, used to sync your inbox, generate priority scores, build daily
              briefings, and power search.
            </li>
            <li>
              <strong>Google Calendar events</strong> — event titles, times, attendees, and
              descriptions, used to sync your schedule and surface it alongside your inbox.
            </li>
          </ul>
          <p>
            We access this data only through Google's official Gmail API and Calendar API, using
            OAuth 2.0. We never ask for or store your Google password.
          </p>

          <h2>2. How We Use Your Data</h2>
          <ul>
            <li>Syncing and displaying your inbox and calendar inside Mailroid.</li>
            <li>
              Scoring and prioritizing emails, and generating summaries/briefings, using
              third-party AI providers (OpenAI and/or DeepSeek). Relevant email or event content is
              sent to these providers solely to generate the requested output (e.g. a priority
              score, summary, or search embedding) and is not used by us to train any model.
            </li>
            <li>
              Maintaining real-time sync via Gmail/Calendar push notifications ("watch"), so new
              messages and events appear without manual refreshing.
            </li>
            <li>Providing AI chat and agent features that act on your inbox/calendar on your behalf, when you initiate them.</li>
          </ul>

          <h2>3. Data Storage</h2>
          <p>
            Your data is stored in a private, encrypted PostgreSQL database. OAuth access and
            refresh tokens are stored securely and used only to make authorized API calls to
            Google on your behalf. You can revoke this access at any time (see Section 5).
          </p>

          <h2>4. Data Sharing</h2>
          <p>
            We do not sell your data. We share data only with the infrastructure and AI providers
            necessary to operate Mailroid (e.g. our database host, and AI providers used for
            summarization/prioritization as described above), each bound by their own data
            processing terms.
          </p>

          <h2>5. Revoking Access</h2>
          <p>
            You can disconnect Mailroid from your Google account at any time via{" "}
            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
              Google Account Permissions
            </a>
            . You may also request deletion of your Mailroid data by contacting us (Section 7).
          </p>

          <h2>6. Data Retention</h2>
          <p>
            We retain synced data for as long as your account is connected, so that Mailroid can
            continue providing sync, search, and prioritization. If you disconnect your account or
            request deletion, we delete the associated data from our systems within a reasonable
            time.
          </p>

          <h2>7. Contact</h2>
          <p>
            Questions about this policy or requests regarding your data can be sent to{" "}
            <a href="mailto:agarwalshriyansh007@gmail.com">agarwalshriyansh007@gmail.com</a>.
          </p>

          <h2>8. Changes to This Policy</h2>
          <p>
            We may update this policy as Mailroid evolves. Material changes will be reflected by
            updating the "Last updated" date above.
          </p>
        </div>
      </div>
    </div>
  );
}
