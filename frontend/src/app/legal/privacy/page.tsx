import type { Metadata } from 'next'
import { LegalDoc, S, H, P, UL, Callout } from '@/components/LegalDoc'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How Axis Performance collects, uses, and shares data.',
}

// Keep in step with CURRENT_PRIVACY_VERSION in backend/app/api/v1/legal.py.
const VERSION = '2026-09-07'

export default function PrivacyPage() {
  return (
    <LegalDoc title="Privacy Policy" version={VERSION}>
      <P>
        <strong>RW AI Infrastructure LLC</strong> (&ldquo;Axis,&rdquo; &ldquo;we,&rdquo;
        &ldquo;us,&rdquo; &ldquo;our&rdquo;) operates the Axis Performance platform. This policy
        explains what we collect, why, who we share it with, and what control you have.
      </P>

      <S>1. Information We Collect</S>

      <H>1.1 Information you give us</H>
      <UL>
        <li><strong>Account:</strong> name, email address, phone number, company name, license number, service area</li>
        <li><strong>Billing:</strong> billing address and subscription history. Card details go directly to Stripe and are never stored on our systems.</li>
        <li><strong>Roof and property data:</strong> street addresses, aerial and satellite imagery, site photos, roof traces and edge labels, pitch confirmations, measurements, and inspection notes</li>
        <li><strong>Business records you create in Axis:</strong> customers, leads, proposals, estimates, schedules, and crew assignments</li>
        <li><strong>Correspondence:</strong> support requests and feedback</li>
      </UL>

      <H>1.2 Information about homeowners</H>
      <P>
        Where you use the Axis instant-quote widget on your own website, we collect the contact
        details and property information the homeowner submits and deliver them to you as a lead.
        For that data, <strong>you are the controller and Axis is your processor</strong> — it is
        collected on your site, for your business, under your customer relationship. You are
        responsible for having a privacy notice on your own site that discloses this collection.
        We process that data to deliver the lead to you and to operate and improve the Platform as
        described below.
      </P>

      <H>1.3 Information collected automatically</H>
      <UL>
        <li><strong>Usage:</strong> pages and features used, reports generated, timestamps</li>
        <li><strong>Device and connection:</strong> IP address, browser, operating system</li>
        <li><strong>Cookies:</strong> session cookies to keep you signed in, and analytics cookies to understand product usage</li>
      </UL>

      <S>2. How We Use Information</S>

      <H>2.1 To run the service</H>
      <UL>
        <li>Provide, maintain, secure, and improve the Platform</li>
        <li>Generate roof measurements, diagrams, and reports</li>
        <li>Process subscriptions, overages, and invoices</li>
        <li>Send service, security, and billing notices</li>
        <li>Provide support</li>
      </UL>

      <H>2.2 To train and improve the AI behind Axis</H>
      <Callout>
        <strong>We train on your roof work, and we want you to know exactly how.</strong> Every
        trace you correct and every pitch you confirm makes the model measure the next roof more
        accurately — for you and for every other contractor on the Platform.
      </Callout>
      <UL>
        <li>
          <strong>What is used:</strong> roof imagery, traces, edge labels, corrections, pitch
          confirmations, and measurements.
        </li>
        <li>
          <strong>What is removed first:</strong> your business identity, your customer&rsquo;s
          name and contact details, and the association between a property and one of your jobs.
          Training data is de-identified and aggregated with many other roofs.
        </li>
        <li>
          <strong>What it is used for:</strong> improving roof detection, edge classification,
          pitch inference, measurement precision, and report quality.
        </li>
        <li>
          <strong>Opting out:</strong> training use is part of the service and cannot be disabled
          while you use the Platform.
        </li>
      </UL>

      <H>2.3 Other business purposes</H>
      <UL>
        <li>Product analytics and capacity planning</li>
        <li>Fraud prevention, abuse detection, and security monitoring</li>
        <li>Legal compliance, enforcing our Terms, and resolving disputes</li>
      </UL>

      <S>3. How We Share Information</S>

      <H>3.1 Service providers</H>
      <P>We share information with vendors that operate parts of the service on our behalf:</P>
      <UL>
        <li><strong>Stripe</strong> — payment processing and subscription billing</li>
        <li><strong>Supabase</strong> — database, authentication, and file storage</li>
        <li><strong>Render and Vercel</strong> — application hosting</li>
        <li><strong>Google, and other AI and imagery providers</strong> — model inference, aerial and satellite imagery, and property data lookups</li>
        <li><strong>Google Workspace</strong> — business email</li>
      </UL>
      <P>These providers may process data only to deliver their service to us.</P>

      <H>3.2 De-identified and aggregated data</H>
      <P>
        We may use, license, or sell de-identified and aggregated data — including roof geometry,
        imagery-derived measurements, and model training sets — for any commercial purpose,
        including supplying third-party partners and training models offered outside the Axis
        product. Data disclosed this way is stripped of information identifying you, your
        business, or your customers, and is aggregated with data from many other roofs. We do not
        attempt to re-identify it and we require recipients not to do so.
      </P>
      <P>
        <strong>We do not sell information that identifies you or your customers.</strong> Your
        customer list, pipeline, proposals, and pricing are not sold or licensed to anyone.
      </P>

      <H>3.3 Legal and corporate</H>
      <P>
        We may disclose information where required by law, subpoena, or valid government request,
        to protect our rights or the safety of others, or in connection with a merger,
        acquisition, or sale of assets — in which case this policy continues to govern the
        transferred data until the successor provides notice of any change.
      </P>

      <S>4. Data Retention</S>
      <UL>
        <li><strong>While your account is active:</strong> we retain your account, roof, and business records so the Platform works.</li>
        <li><strong>After cancellation:</strong> account and project data is retained for 12 months, then deleted, unless a longer period is required by law or needed to resolve a dispute.</li>
        <li><strong>On request:</strong> email us and we will delete your account data within 30 days.</li>
        <li>
          <strong>Training sets:</strong> de-identified data already incorporated into a training
          set or a trained model cannot be extracted from that model and is not deleted by an
          account deletion request. Deleting your account stops any further use of your data for
          future training.
        </li>
      </UL>

      <S>5. Your Rights</S>

      <H>5.1 Everyone</H>
      <P>
        You may request a copy of your account data, ask us to correct inaccurate information, or
        ask us to delete your account and its data. Email the address in Section 9.
      </P>

      <H>5.2 California residents (CCPA/CPRA)</H>
      <P>You have the right to:</P>
      <UL>
        <li>Know the categories and specific pieces of personal information we collect, and the purposes for which we use them</li>
        <li>Request deletion of your personal information, subject to legal exceptions</li>
        <li>Request correction of inaccurate personal information</li>
        <li>Opt out of the sale or sharing of personal information</li>
        <li>Not be discriminated against for exercising these rights</li>
      </UL>
      <P>
        The data we license or sell is de-identified and aggregated, which is outside the
        CCPA&rsquo;s definition of personal information. If you would nonetheless like to register
        an opt-out, email us and we will honor it.
      </P>

      <H>5.3 EU/EEA and UK residents (GDPR)</H>
      <P>
        Where GDPR applies, our legal bases are contract performance (delivering the Platform you
        subscribed to), legitimate interests (securing, analyzing, and improving the service,
        including model training), and legal obligation. You have rights of access,
        rectification, erasure, restriction, portability, and objection, and may lodge a complaint
        with your supervisory authority. Data is processed in the United States.
      </P>

      <S>6. Security</S>
      <UL>
        <li>Data is encrypted in transit using TLS, and at rest by our infrastructure providers.</li>
        <li>Access to production data is limited to authorized personnel.</li>
        <li>Authentication is token-based, and API access is scoped to your account.</li>
        <li>
          No system is perfectly secure. We cannot guarantee absolute security, and you use the
          Platform with that understanding.
        </li>
      </UL>

      <S>7. Cookies</S>
      <P>We use cookies and similar technologies to:</P>
      <UL>
        <li>Keep you signed in and maintain your session</li>
        <li>Remember interface preferences</li>
        <li>Measure feature usage and performance</li>
      </UL>
      <P>
        You can block cookies in your browser, but the Platform will not function correctly
        without session cookies.
      </P>

      <S>8. Children</S>
      <P>
        Axis is a business tool and is not directed to anyone under 18. We do not knowingly
        collect information from children.
      </P>

      <S>9. Changes and Contact</S>
      <P>
        We may update this policy. When a change materially affects your rights, we will notify
        you by email or in-app and ask you to accept the updated version. Your acceptance is
        recorded with its version and date.
      </P>
      <P>
        RW AI Infrastructure LLC<br />
        Wilmington, North Carolina<br />
        <a href="mailto:lance@rwinfrastructure.com" className="text-[#0068d6] underline underline-offset-2">
          lance@rwinfrastructure.com
        </a>
        <br />
        We aim to respond to privacy requests within 30 days.
      </P>
    </LegalDoc>
  )
}
