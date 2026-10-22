// Driver for the NTIA ITM reference implementation (https://github.com/NTIA/itm).
// Reads cases from stdin, one per line:
//   id,h_tx,h_rx,epsilon,sigma,N_0,f_mhz,pol,climate,mdvar,time,location,situation,xi_m,np;elev_dm elev_dm ...
// (elevations in decimetres, np = number of points - 1) and prints one line per case:
//   rtn,warnings,A_db,A_ref_db,A_fs_db,delta_h_m,mode,d_hzn0,d_hzn1,h_e0,h_e1,theta0,theta1,N_s
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "include/itm.h"

int main() {
    std::string line;
    char buf[1 << 20];
    while (fgets(buf, sizeof buf, stdin)) {
        line = buf;
        size_t semi = line.find(';');
        if (semi == std::string::npos) continue;
        long id; double h_tx, h_rx, eps, sigma, n0, f; int pol, climate, mdvar; double t, l, s, xi; int np;
        if (sscanf(line.c_str(), "%ld,%lf,%lf,%lf,%lf,%lf,%lf,%d,%d,%d,%lf,%lf,%lf,%lf,%d",
                   &id, &h_tx, &h_rx, &eps, &sigma, &n0, &f, &pol, &climate, &mdvar, &t, &l, &s, &xi, &np) != 15) continue;
        std::vector<double> pfl(np + 3);
        pfl[0] = np;
        pfl[1] = xi;
        const char* p = line.c_str() + semi + 1;
        for (int i = 0; i <= np; i++) {
            char* end;
            double dm = strtod(p, &end);
            pfl[i + 2] = dm / 10.0;
            p = end;
        }
        double A = 0; long warnings = 0; IntermediateValues iv; memset(&iv, 0, sizeof iv);
        int rtn = ITM_P2P_TLS_Ex(h_tx, h_rx, pfl.data(), climate, n0, f, pol, eps, sigma, mdvar, t, l, s, &A, &warnings, &iv);
        printf("%d,%ld,%.17g,%.17g,%.17g,%.17g,%d,%.17g,%.17g,%.17g,%.17g,%.17g,%.17g,%.17g\n", rtn, warnings, A, iv.A_ref__db,
               iv.A_fs__db, iv.delta_h__meter, iv.mode, iv.d_hzn__meter[0], iv.d_hzn__meter[1], iv.h_e__meter[0], iv.h_e__meter[1],
               iv.theta_hzn[0], iv.theta_hzn[1], iv.N_s);
    }
    return 0;
}
