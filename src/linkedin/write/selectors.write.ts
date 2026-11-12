/**
 * NOT VERIFIED ON THE LIVE SITE.
 *
 * Selectors and wording for the three write operations (invite, message, withdraw). When LinkedIn
 * changes these controls or dialogs, this is the file to edit.
 *
 * Every control is found by role and accessible name (see `Target` in `page.ts`), inside a scope
 * that keeps it to the right person: the profile's top card, the conversation's message form, the
 * person's row of the sent-invitations list. Names are case-insensitive patterns that accept a
 * straight or a curly apostrophe.
 *
 * Marking: a string seen on a saved page says where. Every string marked `// unverified` was not
 * seen on a saved page: the dialogs that open after a click are not in any capture, and no Italian
 * page has been saved. docs/research/write-operations.md lists each one to check on the live site.
 */
import type { InterfaceLanguage } from "../selectors";
import { profileStructure } from "../parse/selectors.profile";
import { listStructure } from "../parse/selectors.lists";
import { thread } from "../parse/selectors.thread";
import type { Scope } from "./page";

export const writeStructure = {
  /**
   * The owner's card on a profile: the profile card holding the Contact info link (the hook
   * `parseProfile` uses on any load). Seen 2026-11-11: it holds Connect, Message and More twice
   * (two layouts, one hidden by a stylesheet); the first visible one is clicked.
   */
  topCard: { css: profileStructure.profileCard, has: profileStructure.contactInfoLink } satisfies Scope,
  /** Connect on a later load links here with `vanityName=<public id>`. Seen 2026-11-11. */
  connectLinkHref: "/custom-invite/",
  /**
   * An open menu. LinkedIn renders the More menu only once it is clicked, possibly outside the top
   * card, so it is looked up on the whole page. // unverified
   */
  menu: { css: "[role='menu']" } satisfies Scope,
  /** A dialog shown on the page: a native `<dialog open>` (2026 pages) or an element with a dialog role. */
  dialog: { css: "dialog[open], [role='dialog'], [role='alertdialog']" } satisfies Scope,
  /** The conversation's message form, not the search box of the New message pane nor a chat bubble. Seen 2026-11-11. */
  messageForm: { css: `${thread.pane} .msg-form` } satisfies Scope,
  /** A row of the sent-invitations list. Seen 2026-11-11. */
  sentRow: listStructure.sentInvitations.row,
  /** The page marker of the sent-invitations list. Seen 2026-11-11. */
  sentScreen: listStructure.sentInvitations.screen,
  /** LinkedIn's limit on an invitation note, in characters (the app's form holds the same limit). // unverified */
  noteMaxLength: 300,
} as const;

/** The row of the sent-invitations list that links this person's profile. Not verified on the live site. */
export function sentRowOf(publicId: string): Scope {
  return { css: writeStructure.sentRow, has: `a[href*=${JSON.stringify(`/in/${encodeURIComponent(publicId)}/`)}]` };
}

export interface WriteWording {
  /** The Connect control: its text, or its aria-label "Invite <name> to connect". */
  readonly connect: RegExp;
  readonly more: RegExp;
  /** The buttons of the dialog that opens after Connect. */
  readonly addNote: RegExp;
  readonly sendWithoutNote: RegExp;
  /** The send button of the note dialog. */
  readonly sendInvitation: RegExp;
  /** The Send button of the message form. */
  readonly sendMessage: RegExp;
  /** The Withdraw control of a sent-invitations row, and the confirm button of its dialog. */
  readonly withdraw: RegExp;
  readonly confirmWithdraw: RegExp;
  /**
   * Phrases of a dialog's text (normalised: lower case, straight apostrophes), tried in this order:
   * LinkedIn's invitation limit, a request for the person's email, the upsell shown when no free
   * note is left this month, the withdraw confirmation.
   */
  readonly limitPhrases: readonly string[];
  readonly emailPhrases: readonly string[];
  readonly noteQuotaPhrases: readonly string[];
  readonly withdrawPhrases: readonly string[];
}

const wording = {
  en: {
    // "Connect" seen as the link text, "Invite Person 1 to connect" as its aria-label, 2026-11-11.
    connect: /^(?:connect|invite .+ to connect)$/i,
    // Seen 2026-11-11 as the More button's text.
    more: /^more(?: actions)?$/i,
    addNote: /^add a note$/i, // unverified
    sendWithoutNote: /^send without a note$/i, // unverified
    sendInvitation: /^send(?: invitation)?(?: now)?$/i, // unverified
    // Seen 2026-11-11 on the message form's Send button.
    sendMessage: /^send$/i,
    // "Withdraw" seen as the row control's text, "Withdraw invitation sent to Person 1" as its aria-label, 2026-11-11.
    withdraw: /^withdraw(?: invitation sent to .+)?$/i,
    confirmWithdraw: /^withdraw$/i, // unverified
    limitPhrases: ["weekly invitation limit", "invitation limit", "reached the weekly limit", "too many invitations"], // unverified
    emailPhrases: ["enter their email", "enter their email address", "verify this member knows you"], // unverified
    noteQuotaPhrases: ["out of free personalized invitations", "personalized invitations with premium", "no personalized invitations left"], // unverified
    withdrawPhrases: ["withdraw invitation", "withdraw this invitation"], // unverified
  },
  it: {
    connect: /^(?:collegati|invita .+ a collegarsi)$/i, // unverified
    more: /^altro$/i, // unverified
    addNote: /^aggiungi una nota$/i, // unverified
    sendWithoutNote: /^invia senza(?: una)? nota$/i, // unverified
    sendInvitation: /^invia(?: invito)?(?: ora)?$/i, // unverified
    sendMessage: /^invia$/i, // unverified
    withdraw: /^ritira(?: invito(?: inviato a .+)?)?$/i, // unverified
    confirmWithdraw: /^ritira$/i, // unverified
    limitPhrases: ["limite settimanale di inviti", "limite di inviti", "troppi inviti"], // unverified
    emailPhrases: ["inserisci il suo indirizzo email", "indirizzo email per collegarti", "questo utente ti conosca"], // unverified
    noteQuotaPhrases: ["inviti personalizzati gratuiti", "inviti personalizzati con premium"], // unverified
    withdrawPhrases: ["ritira invito", "ritirare l'invito"], // unverified
  },
} as const satisfies Record<InterfaceLanguage, WriteWording>;

/** Not verified on the live site. */
export function writeWordingFor(language: InterfaceLanguage): WriteWording {
  return wording[language];
}
