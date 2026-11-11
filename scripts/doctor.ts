import { dataPaths } from "../src/config/paths";
import { formatReport, runDoctor } from "../src/doctor/checks";

const report = runDoctor({ paths: dataPaths() });
process.stdout.write(formatReport(report));
process.exitCode = report.ok ? 0 : 1;
