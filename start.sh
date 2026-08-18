#!/bin/bash
# Wrapper para Linux: curl-cffi-node necesita que libidn2 esté precargado
# porque el binario nativo espera el símbolo idn2_check_version.
export LD_PRELOAD=/lib/x86_64-linux-gnu/libidn2.so.0
node --env-file=.env src/index.js
