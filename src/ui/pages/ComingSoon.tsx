import { EmptyState, SECONDARY_BUTTON } from "../formParts";
import { Link } from "../router";
import { PageHeader } from "./PageHeader";

/** A destination that exists in the menu but is built in the next slice. */
export function ComingSoon({ title, about, lead = "This page is coming in the next slice." }: { readonly title: string; readonly about: string; readonly lead?: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        className="max-w-xl"
        title={lead}
        action={
          <Link to="/" className={`${SECONDARY_BUTTON} btn-sm`}>
            Back to Home
          </Link>
        }
      >
        {about}
      </EmptyState>
    </>
  );
}
