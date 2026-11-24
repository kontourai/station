#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/sysctl.h>
#include <time.h>

int main(int argc, char **argv) {
    if (argc != 2)
        return 2;

    char *end;
    errno = 0;
    long pid = strtol(argv[1], &end, 10);
    if (errno || end == argv[1] || *end || pid <= 0 || pid > INT_MAX)
        return 2;

    struct kinfo_proc info;
    size_t size = sizeof info;
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)pid};
    if (sysctl(mib, 4, &info, &size, NULL, 0) ||
        size != sizeof info || info.kp_proc.p_pid != pid)
        return 1;

    // Preserve Station's historical ps lstart fingerprint in UTC.
    time_t started = info.kp_proc.p_starttime.tv_sec;
    struct tm utc;
    char fingerprint[64];
    if (started <= 0 || !gmtime_r(&started, &utc) ||
        !strftime(fingerprint, sizeof fingerprint, "%a %b %e %T %Y", &utc))
        return 1;

    return puts(fingerprint) == EOF ? 1 : 0;
}
