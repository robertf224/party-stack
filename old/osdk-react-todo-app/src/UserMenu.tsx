import { useCurrentUserId, useUser } from "@bobbyfidz/osdk-react/users";
import { UserAvatar } from "./UserAvatar";
import { useState, useRef, useEffect } from "react";
import { auth } from "./client";

export const UserMenu = () => {
    const [isOpen, setIsOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const userId = useCurrentUserId();
    const { data: user } = useUser(userId);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const fullName = user ? [user.givenName, user.familyName].filter(Boolean).join(" ") : "Unknown User";
    const email = user?.email || "No email available";

    return (
        <div className="relative" ref={menuRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center space-x-2 rounded-full p-1 hover:bg-gray-100"
            >
                <UserAvatar userId={userId} />
            </button>

            {isOpen && (
                <div className="absolute right-0 z-50 mt-2 w-64 rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5">
                    <div className="py-1">
                        <div className="border-b border-gray-100 px-4 py-2">
                            <p className="text-sm font-medium text-gray-900">{fullName}</p>
                            <p className="text-sm text-gray-500">{email}</p>
                        </div>
                        <a
                            href={new URL(import.meta.env.VITE_FOUNDRY_API_URL).origin}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                        >
                            Open Foundry
                        </a>
                        <button
                            onClick={() => auth.signOut()}
                            className="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                        >
                            Sign out
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
