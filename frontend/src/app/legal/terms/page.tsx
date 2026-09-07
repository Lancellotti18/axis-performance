import type { Metadata } from 'next'
import { LegalDoc, S, H, P, UL, Callout } from '@/components/LegalDoc'

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The agreement governing use of the Axis Performance platform.',
}

// Keep this version string in step with CURRENT_TOS_VERSION in
// backend/app/api/v1/legal.py. Bumping it there re-prompts every contractor.
const VERSION = '2026-09-07'

export default function TermsPage() {
  return (
    <LegalDoc title="Terms of Service" version={VERSION}>
      <P>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your use of the Axis Performance
        platform (the &ldquo;Platform&rdquo;), operated by <strong>RW AI Infrastructure LLC</strong>
        {' '}(&ldquo;Axis,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; &ldquo;our&rdquo;). By creating an
        account or using the Platform, you agree to be bound by these Terms. If you are
        agreeing on behalf of a company, you represent that you are authorized to bind it.
      </P>

      <S>1. Subscription and Billing</S>

      <H>1.1 Subscription plans</H>
      <P>Axis is sold as a monthly subscription. Each plan includes:</P>
      <UL>
        <li>A recurring monthly fee</li>
        <li>A monthly allowance of roof reports and, where offered, lead purchases</li>
        <li>Access to the Platform features included in that tier</li>
      </UL>

      <H>1.2 Overage and add-on purchases</H>
      <P>
        If you exceed your monthly allowance, additional reports and leads may be purchased at
        the then-current rates. Lead and report purchases are available to active subscribers
        only; they are not sold separately to non-subscribers. Overage charges appear on your
        next invoice.
      </P>

      <H>1.3 Payment</H>
      <UL>
        <li>Billing recurs monthly on your renewal date until you cancel.</li>
        <li>Payments are processed by Stripe. We do not store your card details.</li>
        <li>Failed or declined payments may result in suspension of access.</li>
        <li>All amounts are in U.S. dollars unless stated otherwise.</li>
      </UL>

      <H>1.4 Cancellation and refunds</H>
      <UL>
        <li>You may cancel at any time from your account settings.</li>
        <li>Cancellation takes effect at the end of the current billing period.</li>
        <li>Fees already paid are non-refundable, including for partial months.</li>
      </UL>

      <S>2. Pricing Changes</S>
      <P>
        Axis is built on third-party AI inference, satellite imagery, and hosting services whose
        costs move over time. We may change subscription pricing, allowances, and overage rates
        to reflect those costs or other business factors.
      </P>
      <UL>
        <li>Price increases take effect no sooner than 30 days after we notify you, by email or in-app.</li>
        <li>You may cancel before the effective date if you do not accept the new pricing.</li>
        <li>Continuing to use the Platform after the effective date constitutes acceptance.</li>
        <li>Current or historical pricing does not guarantee future pricing.</li>
      </UL>

      <S>3. Intellectual Property and Ownership</S>

      <H>3.1 What Axis owns</H>
      <P>As between you and Axis, Axis owns all right, title, and interest in:</P>
      <UL>
        <li>Roof traces, outlines, and facet geometry produced through the Platform</li>
        <li>Roof measurement reports, diagrams, and derived measurements</li>
        <li>All data derived from submitted imagery, including dimensions and structural analysis</li>
        <li>The Axis software, models, algorithms, and underlying technology</li>
      </UL>
      <P>
        You receive a perpetual, non-exclusive license to use the reports and measurements Axis
        generates for you in the ordinary conduct of your contracting business — estimating,
        bidding, ordering material, and presenting work to your own customers. You may not resell
        or redistribute Axis output as a standalone measurement or data product.
      </P>

      <H>3.2 What you submit</H>
      <P>
        By submitting photos, addresses, traces, and related data to the Platform, you grant Axis
        a perpetual, worldwide, irrevocable, royalty-free, sublicensable license to host, store,
        process, reproduce, and create derivative works from that content for the purposes
        described in these Terms and in our Privacy Policy, including Section 4 below.
      </P>
      <P>
        You represent and warrant that you own or have obtained all rights and permissions
        necessary to submit that content, including any consent required from the property owner.
      </P>

      <H>3.3 Trademarks</H>
      <P>
        &ldquo;Axis,&rdquo; &ldquo;Axis Performance,&rdquo; and the Axis marks are trademarks of
        RW AI Infrastructure LLC. Nothing in these Terms grants you a license to use them.
      </P>

      <S>4. Data Used to Train and Improve Axis</S>
      <Callout>
        <strong>Plainly stated:</strong> the roof traces, corrections, imagery, and measurements
        you create on Axis are used to train the AI models behind Axis. This is part of the
        service, not an optional add-on, and it is why the product gets more accurate over time.
      </Callout>
      <P>By subscribing, you agree that:</P>
      <UL>
        <li>
          Roof imagery, traces, edge labels, corrections, and measurements you submit or confirm
          are used to train and evaluate machine-learning models.
        </li>
        <li>
          Data used for training is de-identified and aggregated — your business name, your
          customer&rsquo;s identity, and contact details are removed before it enters a training set.
        </li>
        <li>
          De-identified and aggregated data may be used for any commercial purpose, including
          licensing or selling to third parties, supplying research or commercial partners, and
          training models offered outside the Axis product.
        </li>
        <li>
          Training use cannot be switched off while you use the Platform. If that is not
          acceptable to you, do not use Axis.
        </li>
      </UL>
      <P>
        We do not sell or disclose data that identifies you, your business, your customers, or a
        specific street address as belonging to one of your jobs. Your customer list, pipeline,
        pricing, and proposals are not training data and are not sold.
      </P>

      <S>5. Accuracy — What Axis Does and Does Not Guarantee</S>
      <Callout tone="warn">
        <strong>Axis produces AI-assisted estimates, not certified measurements.</strong> You are
        responsible for verifying every measurement before you rely on it to price, order, or
        perform work.
      </Callout>

      <H>5.1 The nature of the output</H>
      <UL>
        <li>Roof traces are generated from aerial and satellite imagery and are approximations.</li>
        <li>
          Pitch, area, and edge lengths are derived values. Where a pitch is not measured from a
          verified data source, the report discloses that it is assumed or contractor-supplied.
        </li>
        <li>
          Reports are preliminary analysis intended to support your professional judgment — not
          construction documents, engineering opinions, or final specifications.
        </li>
      </UL>

      <H>5.2 Your responsibility to verify</H>
      <P>Before using any Axis output for a bid, order, or installation, you must:</P>
      <UL>
        <li>Physically inspect and measure the roof on site</li>
        <li>Confirm that Axis measurements match actual conditions</li>
        <li>Correct any trace, pitch, or quantity that does not match</li>
        <li>Engage a licensed professional where your work or jurisdiction requires one</li>
      </UL>

      <H>5.3 Not a licensed professional service</H>
      <P>
        Axis is software. RW AI Infrastructure LLC is not a licensed engineering, architectural,
        inspection, or contracting firm, and provides no structural analysis, code determination,
        or professional opinion. Nothing produced by the Platform is a substitute for a licensed
        professional.
      </P>

      <S>6. Service Availability</S>
      <P>
        The Platform is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis,
        without warranties of any kind, express or implied, including implied warranties of
        merchantability, fitness for a particular purpose, and non-infringement. We do not warrant
        uninterrupted or error-free operation, and we publish no uptime commitment or service
        level agreement.
      </P>
      <UL>
        <li>We may perform maintenance, updates, or changes at any time, with or without notice.</li>
        <li>Features may be added, changed, or removed.</li>
        <li>
          We maintain backups but do not guarantee against data loss. Export and retain your own
          copies of reports that matter to your business.
        </li>
      </UL>

      <S>7. Limitation of Liability</S>
      <Callout tone="warn">
        <strong>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, AXIS AND RW AI INFRASTRUCTURE LLC WILL NOT BE
          LIABLE FOR:
        </strong>
        <UL>
          <li>Inaccurate, incomplete, or unavailable traces, measurements, pitches, or reports</li>
          <li>
            Any loss, cost, rework, shortfall, or overage arising from a bid, quote, material
            order, or job priced using Axis output
          </li>
          <li>Claims brought against you by your customers, subcontractors, or third parties</li>
          <li>Lost profits, lost revenue, lost business, or any indirect, incidental, special, consequential, or punitive damages</li>
          <li>Service interruption, data loss, or unauthorized access</li>
          <li>Any consequence of your failure to verify Axis output before relying on it</li>
        </UL>
      </Callout>
      <P>
        <strong>Cap.</strong> Our total aggregate liability arising out of or relating to these
        Terms or the Platform will not exceed the amount you actually paid Axis in the twelve (12)
        months immediately preceding the event giving rise to the claim.
      </P>
      <P>
        <strong>Indemnity.</strong> You agree to indemnify, defend, and hold harmless RW AI
        Infrastructure LLC and its officers and agents from any claim, demand, loss, or expense
        (including reasonable attorneys&rsquo; fees) brought by your customers, third parties, or
        regulators and arising from your use of the Platform, your work, or your reliance on Axis
        output.
      </P>

      <S>8. Acceptable Use</S>
      <P>You agree not to:</P>
      <UL>
        <li>Use the Platform for any unlawful purpose, or in violation of any licensing or permitting requirement applicable to your work</li>
        <li>Reverse engineer, decompile, or attempt to extract the models or source of the Platform</li>
        <li>Scrape, bulk-download, or programmatically harvest Platform data without our written permission</li>
        <li>Resell, sublicense, or repackage Axis output as your own measurement or data product</li>
        <li>Share account credentials outside your organization, or exceed your plan&rsquo;s seat terms</li>
        <li>Submit imagery or data you do not have the right to submit</li>
        <li>Interfere with, overload, or attempt to gain unauthorized access to the Platform</li>
      </UL>
      <P>
        You are responsible for maintaining the confidentiality of your credentials and for all
        activity under your account. Notify us promptly of any unauthorized use. We may suspend or
        terminate an account that violates these Terms.
      </P>

      <S>9. Governing Law and Disputes</S>
      <P>
        These Terms are governed by the laws of the State of North Carolina, without regard to its
        conflict-of-laws rules.
      </P>
      <P>
        <strong>Arbitration.</strong> Any dispute arising out of or relating to these Terms or the
        Platform will be resolved by binding individual arbitration administered in North Carolina
        under the rules of a recognized arbitration provider, rather than in court. Each party
        bears its own fees and costs unless the arbitrator awards otherwise. Either party may
        still seek injunctive relief in court to protect intellectual property or confidential
        information, and either party may bring a qualifying claim in small claims court.
      </P>
      <P>
        <strong>Class action waiver.</strong> Disputes must be brought individually. You and Axis
        each waive any right to bring or participate in a class, collective, or representative
        proceeding.
      </P>

      <S>10. Changes to These Terms</S>
      <P>
        We may update these Terms. When a change materially affects your rights or obligations, we
        will notify you by email or in-app and require you to accept the updated Terms before
        continuing to use the Platform. Your acceptance is recorded with the version and date.
      </P>

      <S>11. Entire Agreement</S>
      <P>
        These Terms and the Privacy Policy are the entire agreement between you and RW AI
        Infrastructure LLC regarding the Platform, and supersede any prior discussions. If any
        provision is held unenforceable, the remainder stays in effect.
      </P>

      <S>12. Contact</S>
      <P>
        RW AI Infrastructure LLC<br />
        Wilmington, North Carolina<br />
        <a href="mailto:lance@rwinfrastructure.com" className="text-[#0068d6] underline underline-offset-2">
          lance@rwinfrastructure.com
        </a>
      </P>
    </LegalDoc>
  )
}
