// The Rust engine and services (crates/urbudget-ios). Every function takes and returns a
// NUL-terminated UTF-8 JSON string; release each returned string with urbudget_free.
#ifndef URBUDGET_CORE_H
#define URBUDGET_CORE_H

char *urbudget_invoke(const char *request);
char *urbudget_initialize(const char *directory);
char *urbudget_service(const char *request);
void urbudget_free(char *value);

#endif
