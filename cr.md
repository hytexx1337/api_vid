Crunchyroll Domains and Endpoints
Domains
stage-api.crunchyroll.com - NOTE: Broken api-manga.crunchyroll.com - NOTE: Broken beta-api.crunchyroll.com - NOTE: Works api.crunchyroll.com - NOTE: Broken beta-stage-api.crunchyroll.com - NOTE: Broken stage-api-manga.crunchyroll.com - NOTE: Broken dev.crunchyroll.com - NOTE: Broken www.crunchyroll.com - NOTE: Semi Works

Endpoints
Content?
          createWatchlistItem: {
                path: "/content/v2/{accountId}/watchlist",
                method: "POST"
            },
            updateWatchlistItem: {
                path: "/content/v2/{accountId}/watchlist/{contentId}",
                method: "PATCH"
            },
            deleteWatchlistItem: {
                path: "/content/v2/{accountId}/watchlist/{contentId}",
                method: "DELETE"
            },
            getPlayheads: {
                path: "/content/v2/{accountId}/playheads?content_ids={contentIds}",
                method: "GET"
            },
            createPlayheads: {
                path: "/content/v2/{accountId}/playheads",
                method: "POST"
            },
            markAsWatched: {
                path: "/content/v2/discover/{accountId}/mark_as_watched/{contentIds}",
                method: "POST"
            },
            getUpNext: {
                path: "/content/v2/discover/up_next/{contentId}",
                method: "GET"
            },
            getPreviousEpisode: {
                path: "/content/v2/discover/previous_episode/{episodeId}",
                method: "GET"
            },
            getWatchlistItems: {
                path: "/content/v2/{accountId}/watchlist?content_ids={contentIds}",
                method: "GET"
            },
            getWatchHistory: {
                path: "/content/v2/{accountId}/watch-history",
                method: "GET"
            },
            deleteHistory: {
                path: "/content/v2/{accountId}/watch-history",
                method: "DELETE"
            },
            deleteHistoryItems: {
                path: "/content/v2/{accountId}/watch-history/{contentIds}",
                method: "DELETE"
            },
            getBrowse: {
                path: "/content/v2/discover/browse",
                method: "GET"
            },
            getBrowseIndex: {
                path: "/content/v2/discover/browse/index",
                method: "GET"
            },
            getSearch: {
                path: "/content/v2/discover/search",
                method: "GET",
                transformResponse: [n.mergeItemsMetadata]
            },
            getFeed: {
                path: "/content/v2/discover/home_feed",
                method: "GET"
            },
            getAccountFeed: {
                path: "/content/v2/discover/{accountId}/home_feed",
                method: "GET"
            },
            getMusicFeed: {
                path: "/content/v2/music/landing_feed",
                method: "GET"
            },
            getAccountWatchlist: {
                path: "/content/v2/discover/{accountId}/watchlist",
                method: "GET"
            },
            getTenantCategories: {
                path: "/content/v2/discover/categories",
                method: "GET"
            },
            getSeasonList: {
                path: "/content/v2/discover/seasonal_tags",
                method: "GET"
            },
            getSubCategories: {
                path: "/content/v2/discover/categories/{parent_category}/sub_categories",
                method: "GET"
            },
            getSimilarTo: {
                path: "/content/v2/discover/similar_to/{guid}",
                method: "GET"
            },
            getAccountSimilarTo: {
                path: "/content/v2/discover/{accountId}/similar_to/{guid}",
                method: "GET"
            },
            getAccountCustomLists: {
                path: "/content/v2/{accountId}/custom-lists",
                method: "GET"
            },
            createCustomList: {
                path: "/content/v2/{accountId}/custom-lists",
                method: "POST"
            },
            createCustomListItem: {
                path: "/content/v2/{accountId}/custom-lists/{listId}",
                method: "POST"
            },
            getCustomListItems: {
                path: "/content/v2/{accountId}/custom-lists/{customListId}",
                method: "GET"
            },
            deleteCustomList: {
                path: "/content/v2/{accountId}/custom-lists/{listId}",
                method: "DELETE"
            },
            updateCustomListItemPosition: {
                path: "/content/v2/{accountId}/custom-lists/{listId}/{contentId}/position",
                method: "PUT"
            },
            updateCustomList: {
                path: "/content/v2/{accountId}/custom-lists/{listId}",
                method: "PATCH"
            },
            deleteCustomListItem: {
                path: "/content/v2/{accountId}/custom-lists/{listId}/{contentId}",
                method: "DELETE"
            },
            getMusicVideos: {
                path: "/content/v2/music/music_videos/{ids}",
                method: "GET"
            },
            getConcerts: {
                path: "/content/v2/music/concerts/{ids}",
                method: "GET"
            },
            getArtists: {
                path: "/content/v2/music/artists/{ids}",
                method: "GET"
            },
            getArtistMusicVideos: {
                path: "/content/v2/music/artists/{id}/music_videos",
                method: "GET"
            },
            getArtistConcerts: {
                path: "/content/v2/music/artists/{id}/concerts",
                method: "GET"
            },
            getMovies: {
                path: "/content/v2/cms/movie_listings/{movieListingId}/movies",
                method: "GET"
            },
            getMovieListing: {
                path: "/content/v2/cms/movie_listings/{movieListingId}",
                method: "GET"
            },
            getObjects: {
                path: "/content/v2/cms/objects/{contentIds}",
                method: "GET"
            },
            getSeries: {
                path: "/content/v2/cms/series/{seriesId}",
                method: "GET"
            },
            getSeasons: {
                path: "/content/v2/cms/series/{seriesId}/seasons?force_locale={forceLocale}",
                method: "GET"
            },
            getEpisodes: {
                path: "/content/v2/cms/seasons/{seasonId}/episodes",
                method: "GET"
            },
            getFeaturedMusic: {
                path: "/content/v2/music/featured/{id}",
                method: "GET"
            },
            getAccountObjects: {
                path: "/content/v2/cms/{accountId}/objects/{ids}",
                method: "GET"
            }
Account Stuff
    getAccount: {
        path: "/accounts/v1/me",
        method: "GET",
        options: {
            bypassLimit: true
        }
    },
    getProfile: {
        path: "/accounts/v1/me/profile",
        method: "GET"
    },
    getProfiles: {
        path: "/accounts/v1/me/multiprofile",
        method: "GET",
        options: {
            bypassLimit: true
        }
    },
    updateProfile: {
        path: "/accounts/v1/me/profile",
        method: "PATCH",
        onSuccess: [n.AuthorizeInterceptor.authorize.bind(n.AuthorizeInterceptor)]
    },
    createMultiProfile: {
        path: "/accounts/v1/me/multiprofile",
        method: "POST"
    },
    updateMultiProfile: {
        path: "/accounts/v1/me/multiprofile/{profileId}",
        method: "PATCH",
        onSuccess: [n.AuthorizeInterceptor.authorize.bind(n.AuthorizeInterceptor)]
    },
    deleteMultiProfile: {
        path: "/accounts/v1/me/multiprofile/{profileId}",
        method: "DELETE"
    },
    getUsernames: {
        path: "/accounts/v1/usernames",
        method: "GET"
    },
    getNotificationSettings: {
        path: "/accounts/v1/me/notification_settings",
        method: "GET"
    },
    updateNotificationSettings: {
        path: "/accounts/v1/me/notification_settings",
        method: "PATCH"
    },
    updateCredentials: {
        path: "/accounts/v1/me/credentials",
        method: "PATCH",
        onSuccess: [n.AuthorizeInterceptor.authorize.bind(n.AuthorizeInterceptor)]
    },
    setPassword: {
        path: "/accounts/v1/me/set_password",
        method: "POST"
    },
    createEmailVerificationLink: {
        path: "/accounts/v1/email_verification",
        method: "POST"
    },
    setEmail: {
        path: "/accounts/v1/phone/set_email",
        method: "POST"
    },
    sendEmailChangeLink: {
        path: "/accounts/v1/email_change_token",
        method: "POST"
    },
    deletePhone: {
        path: "/accounts/v1/phone",
        method: "DELETE"
    },
    requestOTP: {
        path: "/accounts/v1/phone/verify",
        method: "POST"
    },
    setPhone: {
        path: "/accounts/v1/phone",
        method: "PUT"
    }
Too lazy to document so just adding it here if anyone finds it interesting:
"use strict";
(self.__LOADABLE_LOADED_CHUNKS__ = self.__LOADABLE_LOADED_CHUNKS__ || []).push([[3699], {
    65010: (t,e,o)=>{
        o.d(e, {
            Z: ()=>z
        });
        var n = o(19726);
        const r = new n.APIClient({
            createWatchlistItem: {
                path: "/content/v2/{accountId}/watchlist",
                method: "POST"
            },
            updateWatchlistItem: {
                path: "/content/v2/{accountId}/watchlist/{contentId}",
                method: "PATCH"
            },
            deleteWatchlistItem: {
                path: "/content/v2/{accountId}/watchlist/{contentId}",
                method: "DELETE"
            },
            getPlayheads: {
                path: "/content/v2/{accountId}/playheads?content_ids={contentIds}",
                method: "GET"
            },
            createPlayheads: {
                path: "/content/v2/{accountId}/playheads",
                method: "POST"
            },
            markAsWatched: {
                path: "/content/v2/discover/{accountId}/mark_as_watched/{contentIds}",
                method: "POST"
            },
            getUpNext: {
                path: "/content/v2/discover/up_next/{contentId}",
                method: "GET"
            },
            getPreviousEpisode: {
                path: "/content/v2/discover/previous_episode/{episodeId}",
                method: "GET"
            },
            getWatchlistItems: {
                path: "/content/v2/{accountId}/watchlist?content_ids={contentIds}",
                method: "GET"
            },
            getWatchHistory: {
                path: "/content/v2/{accountId}/watch-history",
                method: "GET"
            },
            deleteHistory: {
                path: "/content/v2/{accountId}/watch-history",
                method: "DELETE"
            },
            deleteHistoryItems: {
                path: "/content/v2/{accountId}/watch-history/{contentIds}",
                method: "DELETE"
            },
            getBrowse: {
                path: "/content/v2/discover/browse",
                method: "GET"
            },
            getBrowseIndex: {
                path: "/content/v2/discover/browse/index",
                method: "GET"
            },
            getSearch: {
                path: "/content/v2/discover/search",
                method: "GET",
                transformResponse: [n.mergeItemsMetadata]
            },
            getFeed: {
                path: "/content/v2/discover/home_feed",
                method: "GET"
            },
            getAccountFeed: {
                path: "/content/v2/discover/{accountId}/home_feed",
                method: "GET"
            },
            getMusicFeed: {
                path: "/content/v2/music/landing_feed",
                method: "GET"
            },
            getAccountWatchlist: {
                path: "/content/v2/discover/{accountId}/watchlist",
                method: "GET"
            },
            getTenantCategories: {
                path: "/content/v2/discover/categories",
                method: "GET"
            },
            getSeasonList: {
                path: "/content/v2/discover/seasonal_tags",
                method: "GET"
            },
            getSubCategories: {
                path: "/content/v2/discover/categories/{parent_category}/sub_categories",
                method: "GET"
            },
            getSimilarTo: {
                path: "/content/v2/discover/similar_to/{guid}",
                method: "GET"
            },
            getAccountSimilarTo: {
                path: "/content/v2/discover/{accountId}/similar_to/{guid}",
                method: "GET"
            },
            getAccountCustomLists: {
                path: "/content/v2/{accountId}/custom-lists",
                method: "GET"
            },
            createCustomList: {
                path: "/content/v2/{accountId}/custom-lists",
                method: "POST"
            },
            createCustomListItem: {
                path: "/content/v2/{accountId}/custom-lists/{listId}",
                method: "POST"
            },
            getCustomListItems: {
                path: "/content/v2/{accountId}/custom-lists/{customListId}",
                method: "GET"
            },
            deleteCustomList: {
                path: "/content/v2/{accountId}/custom-lists/{listId}",
                method: "DELETE"
            },
            updateCustomListItemPosition: {
                path: "/content/v2/{accountId}/custom-lists/{listId}/{contentId}/position",
                method: "PUT"
            },
            updateCustomList: {
                path: "/content/v2/{accountId}/custom-lists/{listId}",
                method: "PATCH"
            },
            deleteCustomListItem: {
                path: "/content/v2/{accountId}/custom-lists/{listId}/{contentId}",
                method: "DELETE"
            },
            getMusicVideos: {
                path: "/content/v2/music/music_videos/{ids}",
                method: "GET"
            },
            getConcerts: {
                path: "/content/v2/music/concerts/{ids}",
                method: "GET"
            },
            getArtists: {
                path: "/content/v2/music/artists/{ids}",
                method: "GET"
            },
            getArtistMusicVideos: {
                path: "/content/v2/music/artists/{id}/music_videos",
                method: "GET"
            },
            getArtistConcerts: {
                path: "/content/v2/music/artists/{id}/concerts",
                method: "GET"
            },
            getMovies: {
                path: "/content/v2/cms/movie_listings/{movieListingId}/movies",
                method: "GET"
            },
            getMovieListing: {
                path: "/content/v2/cms/movie_listings/{movieListingId}",
                method: "GET"
            },
            getObjects: {
                path: "/content/v2/cms/objects/{contentIds}",
                method: "GET"
            },
            getSeries: {
                path: "/content/v2/cms/series/{seriesId}",
                method: "GET"
            },
            getSeasons: {
                path: "/content/v2/cms/series/{seriesId}/seasons?force_locale={forceLocale}",
                method: "GET"
            },
            getEpisodes: {
                path: "/content/v2/cms/seasons/{seasonId}/episodes",
                method: "GET"
            },
            getFeaturedMusic: {
                path: "/content/v2/music/featured/{id}",
                method: "GET"
            },
            getAccountObjects: {
                path: "/content/v2/cms/{accountId}/objects/{ids}",
                method: "GET"
            }
        })
          , c = new n.APIClient({
            getAccount: {
                path: "/accounts/v1/me",
                method: "GET",
                options: {
                    bypassLimit: !0
                }
            },
            getProfile: {
                path: "/accounts/v1/me/profile",
                method: "GET"
            },
            getProfiles: {
                path: "/accounts/v1/me/multiprofile",
                method: "GET",
                options: {
                    bypassLimit: !0
                }
            },
            updateProfile: {
                path: "/accounts/v1/me/profile",
                method: "PATCH",
                onSuccess: [n.AuthorizeInterceptor.authorize.bind(n.AuthorizeInterceptor)]
            },
            createMultiProfile: {
                path: "/accounts/v1/me/multiprofile",
                method: "POST"
            },
            updateMultiProfile: {
                path: "/accounts/v1/me/multiprofile/{profileId}",
                method: "PATCH",
                onSuccess: [n.AuthorizeInterceptor.authorize.bind(n.AuthorizeInterceptor)]
            },
            deleteMultiProfile: {
                path: "/accounts/v1/me/multiprofile/{profileId}",
                method: "DELETE"
            },
            getUsernames: {
                path: "/accounts/v1/usernames",
                method: "GET"
            },
            getNotificationSettings: {
                path: "/accounts/v1/me/notification_settings",
                method: "GET"
            },
            updateNotificationSettings: {
                path: "/accounts/v1/me/notification_settings",
                method: "PATCH"
            },
            updateCredentials: {
                path: "/accounts/v1/me/credentials",
                method: "PATCH",
                onSuccess: [n.AuthorizeInterceptor.authorize.bind(n.AuthorizeInterceptor)]
            },
            setPassword: {
                path: "/accounts/v1/me/set_password",
                method: "POST"
            },
            createEmailVerificationLink: {
                path: "/accounts/v1/email_verification",
                method: "POST"
            },
            setEmail: {
                path: "/accounts/v1/phone/set_email",
                method: "POST"
            },
            sendEmailChangeLink: {
                path: "/accounts/v1/email_change_token",
                method: "POST"
            },
            deletePhone: {
                path: "/accounts/v1/phone",
                method: "DELETE"
            },
            requestOTP: {
                path: "/accounts/v1/phone/verify",
                method: "POST"
            },
            setPhone: {
                path: "/accounts/v1/phone",
                method: "PUT"
            }
        });
        var i = o(52746)
          , s = o(58993)
          , a = o(41379);
        const d = (0,
        a.ET)(["headers", s.CLOUDFRONT_COUNTRY_HEADER])
          , u = (0,
        a.qC)((t=>Date.now() + t - 6e4), (0,
        a.Jp)(1e3), (0,
        a.vg)("expires_in"), JSON.parse, (0,
        a.vg)("data"))
          , p = (0,
        n.createCacheHttpAdapter)({
            keyFn: d,
            expireFn: u
        });
        function h(t, e) {
            var o = Object.keys(t);
            if (Object.getOwnPropertySymbols) {
                var n = Object.getOwnPropertySymbols(t);
                e && (n = n.filter((function(e) {
                    return Object.getOwnPropertyDescriptor(t, e).enumerable
                }
                ))),
                o.push.apply(o, n)
            }
            return o
        }
        function m(t, e, o) {
            return (e = function(t) {
                var e = function(t, e) {
                    if ("object" != typeof t || null === t)
                        return t;
                    var o = t[Symbol.toPrimitive];
                    if (void 0 !== o) {
                        var n = o.call(t, e);
                        if ("object" != typeof n)
                            return n;
                        throw new TypeError("@@toPrimitive must return a primitive value.")
                    }
                    return String(t)
                }(t, "string");
                return "symbol" == typeof e ? e : String(e)
            }(e))in t ? Object.defineProperty(t, e, {
                value: o,
                enumerable: !0,
                configurable: !0,
                writable: !0
            }) : t[e] = o,
            t
        }
        const l = new n.APIClient({
            createToken: {
                path: "/auth/v1/token",
                method: "POST",
                options: function(t) {
                    for (var e = 1; e < arguments.length; e++) {
                        var o = null != arguments[e] ? arguments[e] : {};
                        e % 2 ? h(Object(o), !0).forEach((function(e) {
                            m(t, e, o[e])
                        }
                        )) : Object.getOwnPropertyDescriptors ? Object.defineProperties(t, Object.getOwnPropertyDescriptors(o)) : h(Object(o)).forEach((function(e) {
                            Object.defineProperty(t, e, Object.getOwnPropertyDescriptor(o, e))
                        }
                        ))
                    }
                    return t
                }({
                    withCredentials: !0,
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded"
                    }
                }, (0,
                i.Z)() ? {} : {
                    adapter: p
                })
            },
            requestOTP: {
                path: "/auth/v1/phone/verify",
                method: "POST"
            }
        })
          , v = new n.APIClient({
            activateDevice: {
                path: "/auth/v1/device",
                method: "POST"
            },
            getActiveDevices: {
                path: "/accounts/v1/{accountId}/devices/active",
                method: "GET"
            },
            deactivateDevice: {
                path: "/accounts/v1/{accountId}/devices/{deviceId}/deactivate",
                method: "POST"
            },
            deactivateAllDevices: {
                path: "/accounts/v1/{accountId}/devices/deactivate",
                method: "POST"
            }
        })
          , g = new n.APIClient({
            getGuestbooks: {
                path: "/talkbox/guestbooks",
                method: "GET"
            },
            getComments: {
                path: "/talkbox/guestbooks/{guestbook_key}/comments",
                method: "GET"
            },
            getComment: {
                path: "/talkbox/guestbooks/{guestbook_key}/comments/{comment_id}",
                method: "GET"
            },
            createComment: {
                path: "/talkbox/guestbooks/{guestbook_key}/comments",
                method: "POST"
            },
            deleteComment: {
                path: "/talkbox/guestbooks/{guestbook_key}/comments/{comment_id}",
                method: "DELETE"
            },
            getCommentReplies: {
                path: "/talkbox/guestbooks/{guestbook_key}/comments/{comment_id}/replies",
                method: "GET"
            },
            updateCommentFlags: {
                path: "/talkbox/guestbooks/{guestbook_key}/comments/{comment_id}/flags",
                method: "PATCH"
            },
            createCommentVote: {
                path: "/talkbox/guestbooks/{guestbook_key}/comments/{comment_id}/votes",
                method: "POST"
            },
            deleteCommentVote: {
                path: "/talkbox/guestbooks/{guestbook_key}/comments/{comment_id}/votes?vote_type={vote_type}",
                method: "DELETE"
            }
        })
          , I = new n.APIClient({
            getTranslations: {
                path: "/i18n/cxweb/{locale}.json",
                method: "GET"
            },
            getSubtitleLanguages: {
                path: "/config/i18n/v3/timed_text_languages.json",
                method: "GET"
            },
            getAudioLanguages: {
                path: "/config/i18n/v3/audio_languages.json",
                method: "GET"
            }
        });
        var b = o(98746);
        const E = new n.APIClient({
            getBenefits: {
                path: "/subs/v1/subscriptions/{externalAccountId}/benefits",
                method: "GET"
            },
            getFreeTrialEligibility: {
                path: `/subs/v1/subscriptions/{externalAccountId}/eligibility/${b.u}`,
                options: {
                    params: {
                        action: "free_trial_preliminary"
                    }
                },
                method: "GET"
            },
            getProduct: {
                path: "/subs/v2/products/{sku}",
                method: "GET"
            },
            getAccountSubscriptions: {
                path: "/subs/v3/subscriptions/{externalAccountId}",
                method: "GET"
            },
            restartMembership: {
                path: "/subs/v1/subscriptions/{externalAccountId}/checkout",
                method: "POST",
                options: {
                    headers: {
                        "content-type": "application/x-www-form-urlencoded"
                    }
                }
            }
        })
          , T = new n.APIClient({
            getAvatars: {
                path: "/assets/v2/{locale}/avatar",
                method: "GET"
            },
            getWallpapers: {
                path: "/assets/v2/{locale}/wallpaper",
                method: "GET"
            }
        })
          , f = new n.APIClient({
            getContentRating: {
                path: "/content-reviews/v2/rating/{contentType}/{contentId}",
                method: "GET"
            },
            getAnonymousReviews: {
                path: "/content-reviews/v2/{language}/review/{contentType}/{contentId}/list",
                method: "GET"
            },
            getAuthenticatedReviews: {
                path: "/content-reviews/v2/{language}/user/{accountId}/review/{contentType}/{contentId}/list",
                method: "GET"
            },
            getAnonymousReview: {
                path: "/content-reviews/v2/review/{reviewId}",
                method: "GET"
            },
            getAuthenticatedReview: {
                path: "/content-reviews/v2/user/{accountId}/review/{reviewId}",
                method: "GET"
            },
            getUserReview: {
                path: "/content-reviews/v2/{language}/user/{accountId}/review/{contentType}/{contentId}",
                method: "GET"
            },
            getUserContentRating: {
                path: "/content-reviews/v2/user/{accountId}/rating/{contentType}/{contentId}",
                method: "GET"
            },
            updateContentRating: {
                path: "/content-reviews/v2/user/{accountId}/rating/{contentType}/{contentId}",
                method: "PUT"
            },
            deleteContentRating: {
                path: "/content-reviews/v2/user/{accountId}/rating/{contentType}/{contentId}",
                method: "DELETE"
            },
            reportReview: {
                path: "/content-reviews/v2/user/{accountId}/report/review/{reviewId}",
                method: "PUT"
            },
            deleteReportReview: {
                path: "/content-reviews/v2/user/{accountId}/report/review/{reviewId}",
                method: "DELETE"
            },
            createReview: {
                path: "/content-reviews/v2/{language}/user/{accountId}/review/{contentType}/{contentId}",
                method: "POST"
            },
            updateReview: {
                path: "/content-reviews/v2/{language}/user/{accountId}/review/{contentType}/{contentId}",
                method: "PATCH"
            },
            deleteReview: {
                path: "/content-reviews/v2/{language}/user/{accountId}/review/{contentType}/{contentId}",
                method: "DELETE"
            }
        })
          , y = new n.APIClient({
            getEtpConfig: {
                path: "/config/cx-web/config.json",
                method: "GET"
            }
        })
          , w = new n.APIClient({
            getMessages: {
                path: "/in-app-messaging/messages/{accountId}",
                method: "GET"
            },
            setViewed: {
                path: "/in-app-messaging/set_viewed/{accountId}",
                method: "POST"
            }
        })
          , P = new n.APIClient({
            getConnectedPlatforms: {
                path: "/third-party-oauth/v1/connected_platforms",
                method: "GET"
            },
            getPlatformAuthorizeUrl: {
                path: "/third-party-oauth/v1/{platform}/authorize_url?callback_redirect={redirectUrl}",
                method: "GET"
            },
            disconnectPlatform: {
                path: "/third-party-oauth/v1/{platform}/token",
                method: "DELETE"
            }
        });
        var O = o(14081);
        function A(t, e) {
            var o = Object.keys(t);
            if (Object.getOwnPropertySymbols) {
                var n = Object.getOwnPropertySymbols(t);
                e && (n = n.filter((function(e) {
                    return Object.getOwnPropertyDescriptor(t, e).enumerable
                }
                ))),
                o.push.apply(o, n)
            }
            return o
        }
        function _(t) {
            for (var e = 1; e < arguments.length; e++) {
                var o = null != arguments[e] ? arguments[e] : {};
                e % 2 ? A(Object(o), !0).forEach((function(e) {
                    C(t, e, o[e])
                }
                )) : Object.getOwnPropertyDescriptors ? Object.defineProperties(t, Object.getOwnPropertyDescriptors(o)) : A(Object(o)).forEach((function(e) {
                    Object.defineProperty(t, e, Object.getOwnPropertyDescriptor(o, e))
                }
                ))
            }
            return t
        }
        function C(t, e, o) {
            return (e = function(t) {
                var e = function(t, e) {
                    if ("object" != typeof t || null === t)
                        return t;
                    var o = t[Symbol.toPrimitive];
                    if (void 0 !== o) {
                        var n = o.call(t, e);
                        if ("object" != typeof n)
                            return n;
                        throw new TypeError("@@toPrimitive must return a primitive value.")
                    }
                    return String(t)
                }(t, "string");
                return "symbol" == typeof e ? e : String(e)
            }(e))in t ? Object.defineProperty(t, e, {
                value: o,
                enumerable: !0,
                configurable: !0,
                writable: !0
            }) : t[e] = o,
            t
        }
        class S {
            constructor() {
                this.intercept = this.intercept.bind(this)
            }
            intercept(t) {
                const e = t.headers || {};
                return e[S.X_CONSUMER_HEADER] = S.CONSUMER,
                _(_({}, t), {}, {
                    headers: e
                })
            }
            getInterceptor() {
                return this.intercept
            }
            static get X_CONSUMER_HEADER() {
                return "X-Consumer"
            }
            static get CONSUMER() {
                return "com.crunchyroll.cxweb"
            }
        }
        const G = new S
          , j = new n.APIClient({
            migrateWatchData: {
                path: "/fun-migrator/v1/watch-data/{accountId}/migrate/{status}",
                method: "POST"
            }
        })
          , D = new n.APIClient({
            getStreams: {
                path: "/v1/{contentId}/web/{deviceSubType}/play",
                method: "GET"
            },
            getMusicPlayService: {
                path: "/v1/music/{contentId}/web/{deviceSubType}/play",
                method: "GET"
            },
            endVideoSession: {
                path: "/v1/token/{contentId}/{videoToken}",
                method: "DELETE"
            }
        })
          , R = new n.APIClient({
            getCouponDetails: {
                path: "/v1/coupon/{couponId}",
                method: "GET",
                options: {
                    retry: 3,
                    retryDelay: 500
                }
            },
            redeemCoupon: {
                path: "/v1/coupon/{couponId}",
                method: "POST",
                options: {
                    retry: 2,
                    retryDelay: 500
                }
            }
        });
        var k;
        R.addResponseInterceptor(void 0, (k = R,
        t=>{
            const {config: e, response: o} = t;
            if (!e?.retry || o?.status < 500)
                return Promise.reject(t);
            const n = e.retryDelay || 1e3;
            return e.delayMultiplier = e.delayMultiplier || 1,
            e.retry -= 1,
            new Promise((t=>{
                const o = Math.min(n * e.delayMultiplier, 5e3);
                setTimeout(t, o),
                e.delayMultiplier *= 2
            }
            )).then((()=>k.transport.request(e)))
        }
        ));
        const L = R
          , x = new n.APIClient({
            getNews: {
                path: "/{locale}/home-feed?top_news_n={top}&latest_news_n={latest}",
                method: "GET"
            }
        });
        n.Content = r,
        n.Account = c,
        n.Auth = l,
        n.Devices = v,
        n.Talkbox = g,
        n.Localization = I,
        n.Subscription = E,
        n.Assets = T,
        n.Reviews = f,
        n.EtpConfig = y,
        n.Messaging = w,
        n.ThirdPartyOAuth = P,
        n.FunMigrator = j,
        n.PlayService = D,
        n.Incentives = L,
        n.News = x,
        v.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        r.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        f.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        c.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        g.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        E.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        T.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        l.addRequestInterceptor(O.Z.getInterceptor()),
        w.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        w.addRequestInterceptor(G.getInterceptor()),
        P.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        j.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        D.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        L.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor()),
        x.addRequestInterceptor(n.AuthorizeInterceptor.getInterceptor());
        const z = n
    }
    ,
    38422: (t,e,o)=>{
        o.d(e, {
            Z: ()=>r
        });
        var n = o(41379);
        const r = new class {
            constructor() {
                this.audioLanguage = null,
                this.intercept = this.intercept.bind(this)
            }
            setAudioLanguage(t) {
                this.audioLanguage = t
            }
            intercept(t) {
                const {baseURL: e, url: o} = t
                  , r = new URL((0,
                n.zo)(e, o));
                return this.audioLanguage && !r.searchParams.get("preferred_audio_language") && (t.params = t.params || {},
                t.params.preferred_audio_language = this.audioLanguage),
                t
            }
            getInterceptor() {
                return this.intercept
            }
        }
    }
    ,
    48060: (t,e,o)=>{
        o.d(e, {
            Z: ()=>r
        });
        var n = o(41379);
        const r = new class {
            constructor() {
                this.locale = null,
                this.intercept = this.intercept.bind(this)
            }
            setLocale(t) {
                this.locale = t
            }
            intercept(t) {
                return ((t,e)=>{
                    const {baseURL: o, url: r} = t
                      , c = new URL((0,
                    n.zo)(o, r));
                    return e && !c.searchParams.get("locale") ? (0,
                    n.uh)(["params", "locale"], e, t) : t
                }
                )(t, this.locale)
            }
            getInterceptor() {
                return this.intercept
            }
        }
    }
    ,
    14081: (t,e,o)=>{
        function n(t, e) {
            var o = Object.keys(t);
            if (Object.getOwnPropertySymbols) {
                var n = Object.getOwnPropertySymbols(t);
                e && (n = n.filter((function(e) {
                    return Object.getOwnPropertyDescriptor(t, e).enumerable
                }
                ))),
                o.push.apply(o, n)
            }
            return o
        }
        function r(t) {
            for (var e = 1; e < arguments.length; e++) {
                var o = null != arguments[e] ? arguments[e] : {};
                e % 2 ? n(Object(o), !0).forEach((function(e) {
                    c(t, e, o[e])
                }
                )) : Object.getOwnPropertyDescriptors ? Object.defineProperties(t, Object.getOwnPropertyDescriptors(o)) : n(Object(o)).forEach((function(e) {
                    Object.defineProperty(t, e, Object.getOwnPropertyDescriptor(o, e))
                }
                ))
            }
            return t
        }
        function c(t, e, o) {
            return (e = function(t) {
                var e = function(t, e) {
                    if ("object" != typeof t || null === t)
                        return t;
                    var o = t[Symbol.toPrimitive];
                    if (void 0 !== o) {
                        var n = o.call(t, e);
                        if ("object" != typeof n)
                            return n;
                        throw new TypeError("@@toPrimitive must return a primitive value.")
                    }
                    return String(t)
                }(t, "string");
                return "symbol" == typeof e ? e : String(e)
            }(e))in t ? Object.defineProperty(t, e, {
                value: o,
                enumerable: !0,
                configurable: !0,
                writable: !0
            }) : t[e] = o,
            t
        }
        o.d(e, {
            Z: ()=>s
        });
        class i {
            constructor() {
                this.country = null,
                this.intercept = this.intercept.bind(this)
            }
            setOverrideCountry(t) {
                this.country = t
            }
            intercept(t) {
                const e = t.headers || {};
                return this.country && (e[i.COUNTRY_OVERRIDE_HEADER] = this.country),
                r(r({}, t), {}, {
                    headers: e
                })
            }
            getInterceptor() {
                return this.intercept
            }
            static get COUNTRY_OVERRIDE_HEADER() {
                return "ETP-Viewer-Country-Override"
            }
        }
        const s = new i
    }
    ,
    31219: (t,e,o)=>{
        function n(t, e) {
            var o = Object.keys(t);
            if (Object.getOwnPropertySymbols) {
                var n = Object.getOwnPropertySymbols(t);
                e && (n = n.filter((function(e) {
                    return Object.getOwnPropertyDescriptor(t, e).enumerable
                }
                ))),
                o.push.apply(o, n)
            }
            return o
        }
        function r(t) {
            for (var e = 1; e < arguments.length; e++) {
                var o = null != arguments[e] ? arguments[e] : {};
                e % 2 ? n(Object(o), !0).forEach((function(e) {
                    c(t, e, o[e])
                }
                )) : Object.getOwnPropertyDescriptors ? Object.defineProperties(t, Object.getOwnPropertyDescriptors(o)) : n(Object(o)).forEach((function(e) {
                    Object.defineProperty(t, e, Object.getOwnPropertyDescriptor(o, e))
                }
                ))
            }
            return t
        }
        function c(t, e, o) {
            return (e = function(t) {
                var e = function(t, e) {
                    if ("object" != typeof t || null === t)
                        return t;
                    var o = t[Symbol.toPrimitive];
                    if (void 0 !== o) {
                        var n = o.call(t, e);
                        if ("object" != typeof n)
                            return n;
                        throw new TypeError("@@toPrimitive must return a primitive value.")
                    }
                    return String(t)
                }(t, "string");
                return "symbol" == typeof e ? e : String(e)
            }(e))in t ? Object.defineProperty(t, e, {
                value: o,
                enumerable: !0,
                configurable: !0,
                writable: !0
            }) : t[e] = o,
            t
        }
        o.d(e, {
            Z: ()=>s
        });
        class i {
            constructor() {
                this.tabId = !1,
                this.intercept = this.intercept.bind(this),
                this.setTabId = this.setTabId.bind(this)
            }
            setTabId(t) {
                this.tabId = t
            }
            intercept(t) {
                if (!this.tabId)
                    return t;
                const e = t.headers || {};
                return r(r({}, t), {}, {
                    headers: r(r({}, e), {}, {
                        [i.TAB_ID_HEADER]: this.tabId
                    })
                })
            }
            getInterceptor() {
                return this.intercept
            }
            static get TAB_ID_HEADER() {
                return "x-cr-tab-id"
            }
        }
        const s = new i
    }
    ,
    76087: (t,e,o)=>{
        o.d(e, {
            y: ()=>a,
            J: ()=>d
        });
        var n = o(97543)
          , r = o(41379)
          , c = o(52352)
          , i = o(18605)
          , s = o(76856);
        const a = (0,
        r.Xp)([(0,
        r.eq)(n.XU), (0,
        r.Bu)(n.d9)])
          , d = t=>async(e,o=i.Dr,n=3)=>{
            const r = (0,
            s.Z)(o);
            return await (0,
            c.Z)(r),
            t(e).catch((o=>{
                if (!a(o.status))
                    throw o;
                if (0 === n)
                    throw o;
                return d(t)(e, r, n - 1)
            }
            ))
        }
    }
}]);
