export const metadata = {
  title: "Privacy Policy | Mailroid",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-4xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: October 1, 2026</p>

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
              <strong>Gmail messages and metadata</strong> — senders, recipients, subject lines,
              timestamps, message content, labels, and read/unread state. Mailroid reads this data
              to show your mail, and uses the access you grant to send email and to change message
              state (for example labels, read status, or moving a message to Bin) when you do so in
              the app.
            </li>
            <li>
              <strong>Google Calendar events</strong> — event titles, times, attendees, and
              descriptions, used to show your schedule, find available times, and create, update,
              or cancel events (including Google Meet links and invitations to attendees) when you
              do so or approve it.
            </li>
          </ul>
          <p>We also store information you give Mailroid directly, such as:</p>
          <ul>
            <li>your answers to the priority-personalization questions and your settings;</li>
            <li>scheduling preferences you save (for example working hours or meeting rules);</li>
            <li>your conversations with the AI assistant;</li>
            <li>feedback you submit.</li>
          </ul>
          <p>
            We access Google data only through Google's official Gmail API and Calendar API, using
            OAuth 2.0. We never ask for or store your Google password.
          </p>

          <h2>2. How We Use Your Data</h2>
          <ul>
            <li>
              Syncing and displaying your inbox and calendar inside Mailroid. To do this, Mailroid
              keeps a synced copy of your messages and events in its database.
            </li>
            <li>
              Maintaining real-time sync via Gmail/Calendar push notifications ("watch"), so new
              messages and events appear without manual refreshing.
            </li>
            <li>
              Search, including search by meaning using AI-generated search embeddings (see
              Section 3).
            </li>
            <li>
              Prioritizing your inbox, generating summaries and daily briefings, and helping you
              write emails, using the AI processing described in Section 3.
            </li>
            <li>
              Scheduling, rescheduling, and cancelling meetings, and keeping track of which email
              thread a meeting belongs to.
            </li>
            <li>
              Providing an AI assistant that can read your inbox and calendar to answer your
              questions, and can propose actions on your behalf. The assistant cannot send email or
              create, change, or cancel calendar events until you approve that specific action.
            </li>
            <li>
              Recording usage of AI features (for example, how many AI requests were made) to
              operate usage limits and show you your usage.
            </li>
          </ul>

          <h2>3. AI Processing</h2>
          <p>
            Mailroid's AI features are powered by OpenAI. Depending on the feature, the following
            is sent to OpenAI:
          </p>
          <ul>
            <li>
              <strong>Priority classification</strong> — the sender (name and email address),
              subject, and a short snippet of each incoming message, together with your
              personalization answers. This runs automatically as mail arrives.
            </li>
            <li>
              <strong>Search indexing</strong> — the subject and body text of your messages, used
              to create search embeddings that are stored in our database, and the text of your
              searches when you search by meaning. This text is sent without masking personal
              identifiers.
            </li>
            <li>
              <strong>Summaries and writing assistance</strong> — the relevant message or thread
              content. Before it is sent, Mailroid replaces detected personal identifiers (such as
              email addresses, phone numbers, and card numbers) and detected secrets (such as
              one-time codes) with placeholders. Detection is automated and may not catch every
              instance.
            </li>
            <li>
              <strong>AI assistant and daily briefings</strong> — your requests, and the email and
              calendar information the assistant retrieves to answer them.
            </li>
            <li>
              <strong>Feedback</strong> — feedback you submit may be sent to OpenAI to
              categorize and evaluate it.
            </li>
          </ul>
          <p>
            We do not use your data to train AI models. Data sent to OpenAI is handled under
            OpenAI's API terms, including its own retention practices.
          </p>
          <p>
            AI output may be inaccurate. Mailroid does not send AI-generated email or make
            AI-generated calendar changes on your behalf unless you explicitly send or approve the
            action.
          </p>

          <h2>4. Google User Data</h2>
          <p>For data Mailroid receives from Google APIs:</p>
          <ul>
            <li>We use it only to provide the Mailroid features described in this policy.</li>
            <li>We do not sell it, and we do not use it for advertising.</li>
            <li>We do not use it to train AI models.</li>
            <li>
              We transfer it only to the service providers listed in Section 6, as needed to
              provide these features, or where required by law.
            </li>
          </ul>

          <h2>5. Data Storage and Security</h2>
          <p>
            Your data is stored in a PostgreSQL database running on our own server. The database is
            not exposed to the public internet. OAuth access and refresh tokens are encrypted
            before they are stored, and are used only to make authorized API calls to Google on
            your behalf.
          </p>
          <p>
            Other stored data — including synced email content, calendar data, search embeddings,
            summaries, and assistant conversations — is not encrypted by Mailroid at the
            application level.
          </p>
          <p>
            Connections to Mailroid use HTTPS. We also apply safeguards such as sanitizing HTML
            email before it is displayed, screening email content for prompt-injection attempts
            before AI processing, rate limiting, and verifying notifications received from Google.
            No method of storage or transmission is completely secure.
          </p>
          <p>
            We keep operational logs to run and troubleshoot the service. Before logs are sent to
            our monitoring provider, they are processed to remove message content and replace
            email addresses.
          </p>

          <h2>6. Data Sharing</h2>
          <p>
            We do not sell your data. We share data only with the providers necessary to operate
            Mailroid, each bound by their own terms:
          </p>
          <ul>
            <li>
              <strong>Google</strong> — Gmail and Google Calendar, where your data originates and
              where actions you take are carried out.
            </li>
            <li>
              <strong>OpenAI</strong> — AI processing, as described in Section 3.
            </li>
            <li>
              <strong>Our server hosting provider</strong> — hosts the server and database that
              run Mailroid.
            </li>
            <li>
              <strong>Inngest</strong> — runs Mailroid's background jobs, such as mailbox sync and
              classification. As part of this, it receives and keeps in its job history some
              message data, including the sender, subject, snippet, and labels of incoming
              messages being classified.
            </li>
            <li>
              <strong>Grafana Cloud</strong> — receives the redacted operational logs described in
              Section 5.
            </li>
          </ul>

          <h2>7. Cookies</h2>
          <p>
            Mailroid uses cookies only to sign you in with Google and keep you signed in. We do not
            use analytics or advertising cookies, and we do not use third-party tracking. Some
            interface state may be kept in your browser's local storage.
          </p>

          <h2>8. Revoking Access</h2>
          <p>
            You can remove Mailroid's access to your Google account at any time via{" "}
            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
              Google Account Permissions
            </a>
            . This stops Mailroid from reading new data or acting on your account. It does not, on
            its own, delete data Mailroid has already stored — see Section 9.
          </p>

          <h2>9. Data Retention and Deletion</h2>
          <p>
            We retain your synced data, and the data derived from it (such as priority labels,
            summaries, search embeddings, and assistant conversations), for as long as your
            Mailroid account exists, including after you revoke Google access. To have your data
            deleted, contact us (Section 10) and we will delete the associated data from our
            systems within a reasonable time.
          </p>

          <h2>10. Contact</h2>
          <p>
            Questions about this policy or requests regarding your data can be sent to{" "}
            <a href="mailto:agarwalshriyansh007@gmail.com">agarwalshriyansh007@gmail.com</a>.
          </p>

          <h2>11. Changes to This Policy</h2>
          <p>
            We may update this policy as Mailroid evolves. Material changes will be reflected by
            updating the "Last updated" date above.
          </p>
        </div>
      </div>
    </div>
  );
}
