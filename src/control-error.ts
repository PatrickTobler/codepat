/** Only deliberately safe control diagnostics may cross the HTTP boundary. */
export class ControlConflict extends Error {
  readonly status = 409;
}
