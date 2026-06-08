================================================================================
  WATERLIFT SOLAR LIMITED — AI SALES AGENT SYSTEM
  Powered by Claude AI (Anthropic) + WhatsApp Cloud API
================================================================================

WHAT IS THIS SYSTEM?
--------------------------------------------------------------------------------
This is an automated AI Sales Agent that runs 24/7 on WhatsApp, handling
incoming customer enquiries for Waterlift Solar Limited across two business
verticals:

  ☀️  Solar Energy Solutions
      (backup power, grid-tied systems, solar water heating, solar pumping)

  💧  Borehole Drilling Services
      (new borehole drilling, rehabilitation, water pumping systems)

When a customer sends a WhatsApp message to the business number, the AI agent
responds instantly — qualifying leads, providing price estimates, booking
callbacks, and notifying the sales team by email — all without any human
involvement.


HOW IT WORKS (SIMPLE OVERVIEW)
--------------------------------------------------------------------------------
1. Customer sends a WhatsApp message to the Waterlift AI number
2. Meta (WhatsApp) forwards the message to this system via a webhook
3. The AI agent reads the message and detects whether it is about Solar or
   Borehole services (based on keywords)
4. Claude AI (Anthropic Sonnet model) generates a knowledgeable, consultative
   reply using Kenya-specific pricing and product knowledge
5. The reply is sent back to the customer on WhatsApp within seconds
6. If the customer is a hot lead, the sales team receives an instant email

The conversation continues naturally — the agent remembers the full chat history
for 24 hours so customers can ask follow-up questions.


WHAT THE AGENT CAN DO
--------------------------------------------------------------------------------
  - Answer questions about solar systems, inverters, batteries, and pricing
  - Answer questions about borehole drilling, depth, pumps, and costs
  - Provide indicative price ranges in Kenyan Shillings (KShs)
  - Capture lead details (name, phone, location, property type, budget)
  - Book callback appointments with the sales team
  - Escalate complex or urgent queries to a human salesperson
  - Send email notifications to info@waterlift.co.ke for every hot lead

WHAT THE AGENT WILL NOT DO
  - Fabricate exact prices (uses ranges and recommends a site survey)
  - Handle payments or contracts
  - Reply to non-text messages (images, voice notes, documents)


EMAIL NOTIFICATIONS
--------------------------------------------------------------------------------
The sales team at info@waterlift.co.ke receives an email when:

  🟡 NEW LEAD       — Customer has been qualified (name, phone, location,
                       service, budget captured)

  🔴 CALLBACK       — Customer has booked a specific date and time for a
                       sales consultant to call them back

  🚨 ESCALATION     — Customer has a complex, urgent, or sensitive query
                       that requires a human to take over


SYSTEM ARCHITECTURE
--------------------------------------------------------------------------------
  webhook.js              Entry point. Receives WhatsApp messages from Meta
                          and passes them to the AI pipeline.

  src/agent/pipeline.js   Core logic. Manages conversation sessions, calls
                          Claude AI, and handles the agentic tool loop.

  src/agent/prompts.js    System prompts. Kenya-specific knowledge for Solar
                          and Borehole domains.

  src/mcp/tools.js        Tool definitions. Describes the actions Claude can
                          take (qualify lead, send quote, book callback, etc.)

  src/mcp/mcpServer.js    Tool handlers. Executes the actions and calculates
                          KShs price quotes.

  src/services/whatsapp.js  Sends messages back to customers via WhatsApp
                             Cloud API.

  src/services/email.js   Sends HTML email notifications to the sales team
                          via SMTP.

  data/sessions.json      Stores active conversation sessions so they survive
                          app restarts.

  .env                    Secret credentials (API keys, tokens, SMTP password).
                          Never share or commit this file.


HOSTING & ACCESS
--------------------------------------------------------------------------------
  Live URL       : https://salesai.waterliftsolarsavings.africa
  Webhook URL    : https://salesai.waterliftsolarsavings.africa/webhook
  Health Check   : https://salesai.waterliftsolarsavings.africa/health
  Hosting        : cPanel (LiteSpeed Node.js, v19.9.0)
  Server path    : /home/vdramulh/salesai.waterliftsolarsavings.africa/

To restart the app: cPanel → Node.js Apps → Restart


CREDENTIALS REQUIRED (stored in .env)
--------------------------------------------------------------------------------
  ANTHROPIC_API_KEY         Claude AI API key (Anthropic)
  WHATSAPP_PHONE_NUMBER_ID  The dedicated AI agent WhatsApp phone number ID
  WHATSAPP_ACCESS_TOKEN     Permanent System User token from Meta Business Manager
  WHATSAPP_VERIFY_TOKEN     Custom token used to verify the webhook with Meta
  CLAUDE_MODEL              AI model in use (currently: claude-sonnet-4-6)
  SMTP_HOST                 Email server (mail.waterlift.co.ke)
  SMTP_USER                 info@waterlift.co.ke
  SMTP_PASS                 Email account password
  NOTIFICATION_EMAIL        Where lead notifications are sent (info@waterlift.co.ke)


THE 24-HOUR MESSAGING WINDOW — WHAT IT IS & HOW TO OVERCOME IT
--------------------------------------------------------------------------------
WHAT IS THE 24-HOUR WINDOW?

WhatsApp Business API enforces a strict rule: once a customer sends your number
a message, you have exactly 24 hours to reply freely. After that window closes
(if the customer has not sent another message), WhatsApp blocks your business
from sending any further messages to that customer.

This means:
  - Customer messages Monday at 10am → window open until Tuesday 10am
  - If they do not reply again and you try to send Tuesday evening → BLOCKED
  - The AI agent cannot follow up, send a quote reminder, or re-engage them

This protects WhatsApp users from spam, but it creates a challenge for sales
follow-ups on leads that went cold after the first conversation.


WHY THIS MATTERS FOR WATERLIFT
  - A customer asks about a 5kW solar system, gets a quote, then goes silent
  - Your sales team wants to follow up the next day — the agent cannot send
    any message because the window is closed
  - High-ticket sales (solar, boreholes) often require multiple touchpoints
    before a customer commits — losing that window means losing warm leads


THE SOLUTION — WHATSAPP MESSAGE TEMPLATES (HSMs)
  Meta provides a way to message customers outside the 24-hour window using
  pre-approved message templates called HSMs (Highly Structured Messages).

  These are fixed-format messages submitted to Meta for review. Once approved,
  the agent can send them to any customer regardless of when they last replied.

  EXAMPLES OF USEFUL TEMPLATES FOR WATERLIFT:

  Follow-up after quote:
    "Hi {{name}}, this is Waterlift Solar. Just checking if you had any
     questions about the solar quote we shared. We're happy to arrange a
     free site visit at your convenience. Reply to continue chatting."

  Callback reminder:
    "Hi {{name}}, reminder that your Waterlift consultation is scheduled for
     {{date}} at {{time}}. Our specialist will call {{phone}}. Reply CONFIRM
     or RESCHEDULE."

  Re-engagement after silence:
    "Hi {{name}}, Waterlift Solar here. Your borehole inquiry is still open —
     ready to take the next step? Reply YES to continue or STOP to opt out."


HOW TO SET UP MESSAGE TEMPLATES
  Step 1: Add a payment method to your Meta Business Manager account
          (Settings → Billing → Add Payment Method)

  Step 2: Go to Meta Business Manager → WhatsApp Manager → Message Templates
          → Create Template

  Step 3: Choose category (Marketing for follow-ups), write your template,
          submit for Meta review (typically approved within 24-48 hours)

  Step 4: Once approved, the development team adds a sendTemplateMessage()
          function to the system so the agent can trigger it automatically


PRICING — HOW MUCH DOES IT COST?
--------------------------------------------------------------------------------
WhatsApp Cloud API uses a conversation-based pricing model. Here is what you
need to know:

  FREE — Customer-initiated conversations (Service conversations)
    When a customer messages YOU first, the entire 24-hour conversation
    window is completely FREE. This means all current AI agent conversations
    cost you nothing on the WhatsApp side.

    ✅ Customer messages → Agent replies → Entire conversation = FREE

  PAID — Business-initiated conversations (outside the 24-hour window)
    When YOU send the first message to a customer (via a template), this
    opens a new paid conversation window.

    Approximate pricing for Kenya / Africa region:
    ┌─────────────────────────────┬────────────────────────────┐
    │ Conversation Type           │ Approx. Cost per 24h Window│
    ├─────────────────────────────┼────────────────────────────┤
    │ Marketing (follow-ups)      │ ~$0.0125  (~KShs 1.60)     │
    │ Utility (booking reminders) │ ~$0.008   (~KShs 1.03)     │
    │ Authentication (OTP)        │ ~$0.008   (~KShs 1.03)     │
    │ Service (customer replies)  │ FREE                       │
    └─────────────────────────────┴────────────────────────────┘

  FREE MONTHLY ALLOWANCE
    Meta gives every business 1,000 free conversations per month across
    all categories. For a growing business like Waterlift, the majority of
    conversations will fall within this free tier for a long time.

  EXAMPLE COST CALCULATION
    Suppose you follow up on 200 cold leads per month with a marketing
    template:
      200 conversations × $0.0125 = $2.50/month (~KShs 323)

    For 500 follow-ups per month:
      500 × $0.0125 = $6.25/month (~KShs 806)

    This is extremely affordable compared to the value of a single closed
    solar or borehole deal (KShs 180,000 – 2,500,000+).


THE BUSINESS ADVANTAGE
--------------------------------------------------------------------------------
  1. NEVER LOSE A WARM LEAD
     Even if a customer goes silent for days, the agent can re-engage them
     with a polite, personalised template message — keeping Waterlift top
     of mind until they are ready to buy.

  2. AUTOMATED FOLLOW-UPS AT SCALE
     Manually following up on 50+ leads per month is time-consuming for
     your sales team. With templates, the system does it automatically at
     exactly the right time (e.g. 24 hours after silence, 1 hour before
     a booked callback).

  3. HIGHER CONVERSION RATE
     Research shows it takes an average of 5–8 touchpoints to close a
     high-ticket sale. The 24-hour window limits you to 1 touchpoint.
     Templates remove that ceiling.

  4. COST VS. RETURN ON INVESTMENT
     At ~KShs 1.60 per follow-up, following up on 300 leads costs ~KShs 480.
     One closed borehole deal alone is worth KShs 200,000+. The ROI is
     extraordinary.

  5. PROFESSIONAL CUSTOMER EXPERIENCE
     Customers receive timely, branded messages instead of silence after
     their enquiry — building trust and credibility for Waterlift Solar.


PENDING FEATURES (planned for future development)
--------------------------------------------------------------------------------
  1. WhatsApp Message Templates
     For proactive follow-ups after 24 hours of customer silence.

  2. WhatsApp Product Catalog Integration
     Agent sends interactive product cards from the existing Meta catalog
     directly inside WhatsApp conversations.

  3. Admin Dashboard
     Browser-based page at /admin showing all active conversations,
     lead status, and message history.

  4. Meta Business Verification
     Required to unlock higher WhatsApp messaging volume limits.


SUPPORT & CONTACTS
--------------------------------------------------------------------------------
  Business       : Waterlift Solar Limited
  Website        : https://waterliftsolar.africa
  Email          : info@waterlift.co.ke
  Phone          : +254 768 117 070
  Notifications  : info@waterlift.co.ke

  System built with Claude Code (Anthropic)
================================================================================
