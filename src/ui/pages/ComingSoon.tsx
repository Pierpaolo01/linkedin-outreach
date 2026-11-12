import { Link } from "../router";
import { PageHeader } from "./PageHeader";

/** A destination that exists in the menu but is built in the next slice. */
export function ComingSoon({ title, about, lead = "This page is coming in the next slice." }: { readonly title: string; readonly about: string; readonly lead?: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="mt-6 max-w-xl rounded-box border border-base-300 px-5 py-5">
        <p className="font-medium">{lead}</p>
        <p className="mt-1 text-base-content/70">{about}</p>
        <Link to="/" className="btn btn-sm mt-4 border-base-300 bg-base-100">
          Back to Home
        </Link>
      </div>
    </>
  );
}
